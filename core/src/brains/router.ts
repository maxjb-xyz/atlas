// Picks brains for a role from its ordered chain, and tracks provider health
// (§18): a failing provider is skipped within seconds, not after a timeout.
// Fallbacks apply to one turn only; the chain itself never changes here.
// Every call ends here too, so this is where the limit facts are kept: each
// brain's measured speed, what a plan said about its window, when a brain
// that ran out can be used again, and what paid brains have cost this month,
// held to the owner's spending cap.

import type { BrainChoice } from "../store/settings";
import { addSpend, costOf, current, dollars, isPaid, nextMonthUtc, paidThisMonth, type Spend } from "./catalog";
import type { Health } from "./limits";
import { type Brain, BrainError, brainKey, type PlanLimits, type Usage } from "./types";

export type { Health } from "./limits";

export type MakeBrain = (choice: BrainChoice) => Brain | null;

/** Where health and spending are kept across restarts, so a brain that was slow a minute ago isn't tried first again after Atlas slept. */
export interface HealthStore {
  load(): Record<string, Health> | null;
  save(all: Record<string, Health>): void;
  loadSpend?(): Spend | null;
  saveSpend?(s: Spend): void;
}

/** What one call showed, for speed, spending and limits. */
export interface CallFacts {
  usage?: Usage;
  /** From the request to its first event. */
  first_ms?: number | null;
  /** From the request to its last event. */
  total_ms?: number;
  limits?: PlanLimits;
}

/** A brain that didn't start answering in time, or was beaten to it by the next one. */
export class SlowBrainError extends BrainError {}

const MINUTE = 60_000;
/** How many runs the speed averages over: enough to settle, short enough to follow a provider that changed. */
const SPEED_RUNS = 10;

export class BrainRouter {
  readonly health = new Map<string, Health>();
  #loaded = false;
  #spend: Spend | null = null;

  constructor(
    private readonly make: MakeBrain,
    private readonly store?: HealthStore,
    /** The owner's monthly cap for paid brains, in dollars (§18), or null for none. */
    private readonly cap?: () => number | null,
  ) {}

  /**
   * The brains to try, in order. Unconfigured ones (ChatGPT signed out) are
   * left out. Ones cooling down after a failure go last rather than vanishing,
   * so a chain whose every brain failed recently still gets one more try. A
   * paid brain past this month's cap stays in the chain, refusing in words,
   * so the run and a job see why.
   */
  chain(choices: BrainChoice[], now = Date.now()): Brain[] {
    this.#load();
    const ready: Brain[] = [];
    const cooling: Brain[] = [];
    const cap = this.cap?.() ?? null;
    const spent = cap != null ? paidThisMonth(this.#spend, now) : 0;
    for (const choice of choices) {
      let brain = this.make(choice);
      if (!brain) continue;
      const h = this.health.get(brainKey(choice));
      if (cap != null && isPaid(choice) && spent >= cap) {
        brain = capped(brain, cap, spent, now);
        cooling.push(brain);
        continue;
      }
      (h?.until && h.until > now ? cooling : ready).push(brain);
    }
    return [...ready, ...cooling];
  }

  markOk(brain: { provider: string; model: string }, facts: CallFacts = {}): void {
    this.#load();
    const now = Date.now();
    const key = brainKey(brain);
    const was = this.health.get(key);
    const speed = blend(was?.speed, facts);
    const limits = facts.limits ?? was?.limits;
    this.health.set(key, { ok: true, checked_at: now, ...(speed ? { speed } : {}), ...(limits ? { limits } : {}) });
    if (!was?.ok || speed !== was?.speed || facts.limits) this.#save();
    if (facts.usage) {
      const usd = costOf(brain, facts.usage);
      if (usd) {
        this.#spend = addSpend(this.#spend, brain, usd, now);
        this.store?.saveSpend?.(this.#spend);
      }
    }
  }

  /**
   * Cools a brain down. A slow start keeps it out of the way for 2 minutes,
   * doubling each time in a row up to half an hour, since a slow provider tends
   * to stay slow; other failures start at a minute. Running out of usage (429)
   * waits until the provider said it resets, or 15 minutes, and a bad key or
   * unknown model 10.
   */
  markFailed(brain: { provider: string; model: string }, err: unknown): Health {
    this.#load();
    const now = Date.now();
    const key = brainKey(brain);
    const reason = err instanceof Error ? err.message : String(err);
    const was = this.health.get(key);
    const strikes = (was && !was.ok ? (was.strikes ?? 1) : 0) + 1;
    const twice = 2 ** Math.min(strikes - 1, 4);
    // Read by shape, not class: a brain made in another module (a test's, an extension's) throws its own BrainError.
    const e = (err ?? {}) as { status?: unknown; permanent?: unknown; resetAt?: unknown };
    // A brain known to be out until a time stays out until then, whatever its next failure says.
    const resets =
      typeof e.resetAt === "number" && e.resetAt > now ? e.resetAt : was?.resets_at && was.resets_at > now ? was.resets_at : undefined;
    let cool = Math.min(MINUTE * twice, 15 * MINUTE);
    if (err instanceof SlowBrainError) cool = Math.min(2 * MINUTE * twice, 30 * MINUTE);
    else if (resets) cool = resets - now;
    else if (e.status === 429) cool = 15 * MINUTE;
    else if (e.permanent === true) cool = 10 * MINUTE;
    const h: Health = {
      ok: false,
      reason,
      checked_at: now,
      until: now + cool,
      strikes,
      ...(resets ? { resets_at: resets } : {}),
      ...(was?.speed ? { speed: was.speed } : {}),
      ...(was?.limits ? { limits: was.limits } : {}),
    };
    this.health.set(key, h);
    this.#save();
    return h;
  }

  /** The soonest a chain that ran out can be used again, when its provider said; null when nobody said. */
  resetOf(choices: BrainChoice[], now = Date.now()): number | null {
    this.#load();
    const times = choices.map((c) => this.health.get(brainKey(c))?.resets_at).filter((t): t is number => t != null && t > now);
    return times.length ? Math.min(...times) : null;
  }

  /** Spending this month and Workers AI's neurons today, with the cap. */
  spend(now = Date.now()): Spend & { paid: number; cap: number | null } {
    this.#load();
    return { ...current(this.#spend, now), paid: paidThisMonth(this.#spend, now), cap: this.cap?.() ?? null };
  }

  snapshot(): Record<string, Omit<Health, "strikes">> {
    this.#load();
    const out: Record<string, Omit<Health, "strikes">> = {};
    for (const [k, { strikes: _s, ...h }] of this.health) out[k] = h;
    return out;
  }

  #load(): void {
    if (this.#loaded || !this.store) return;
    this.#loaded = true;
    for (const [k, h] of Object.entries(this.store.load() ?? {})) if (!this.health.has(k)) this.health.set(k, h);
    this.#spend = this.store.loadSpend?.() ?? null;
  }

  #save(): void {
    this.store?.save(Object.fromEntries(this.health));
  }
}

/** The average speed with one more run in it, or the old one when this run didn't show its speed. */
function blend(was: Health["speed"], f: CallFacts): Health["speed"] {
  if (f.first_ms == null) return was;
  const out = f.usage?.output ?? 0;
  const streaming = f.total_ms != null ? f.total_ms - f.first_ms : 0;
  // Too short an answer says more about the network than the model.
  const tps = out >= 20 && streaming >= 250 ? out / (streaming / 1000) : null;
  if (!was) return { first_ms: Math.round(f.first_ms), tps: tps != null ? Math.round(tps) : null, runs: 1 };
  const n = Math.min(was.runs + 1, SPEED_RUNS);
  const avg = (old: number, x: number) => old + (x - old) / n;
  return {
    first_ms: Math.round(avg(was.first_ms, f.first_ms)),
    tps: tps == null ? was.tps : Math.round(was.tps == null ? tps : avg(was.tps, tps)),
    runs: was.runs + 1,
  };
}

/** A paid brain past the month's cap: it refuses, with the cap, what's been spent and when it starts again. */
function capped(brain: Brain, cap: number, spent: number, now: number): Brain {
  return {
    provider: brain.provider,
    model: brain.model,
    // eslint-disable-next-line require-yield
    async *stream() {
      const reset = nextMonthUtc(now);
      throw new BrainError(
        `This month's spending cap for paid brains (${dollars(cap)}) is reached: ${dollars(spent)} so far. It starts again on ${new Date(reset).toISOString().slice(0, 10)}, or raise it in Settings → Brains.`,
        false,
        429,
        reset,
      );
    },
  };
}
