// Picks brains for a role from its ordered chain, and tracks provider health
// (§18): a failing provider is skipped within seconds, not after a timeout.
// Fallbacks apply to one turn only; the chain itself never changes here.

import type { BrainChoice } from "../store/settings";
import { type Brain, BrainError, brainKey } from "./types";

export interface Health {
  ok: boolean;
  reason?: string;
  checked_at: number;
  /** Skip this brain until then. */
  until?: number;
  /** Failures in a row: each one keeps the brain out of the way for longer. */
  strikes?: number;
}

export type MakeBrain = (choice: BrainChoice) => Brain | null;

/** Where health is kept across restarts, so a brain that was slow a minute ago isn't tried first again after Atlas slept. */
export interface HealthStore {
  load(): Record<string, Health> | null;
  save(all: Record<string, Health>): void;
}

/** A brain that didn't start answering in time, or was beaten to it by the next one. */
export class SlowBrainError extends BrainError {}

const MINUTE = 60_000;

export class BrainRouter {
  readonly health = new Map<string, Health>();
  #loaded = false;

  constructor(
    private readonly make: MakeBrain,
    private readonly store?: HealthStore,
  ) {}

  /**
   * The brains to try, in order. Unconfigured ones (ChatGPT signed out) are
   * left out. Ones cooling down after a failure go last rather than vanishing,
   * so a chain whose every brain failed recently still gets one more try.
   */
  chain(choices: BrainChoice[], now = Date.now()): Brain[] {
    this.#load();
    const ready: Brain[] = [];
    const cooling: Brain[] = [];
    for (const choice of choices) {
      const brain = this.make(choice);
      if (!brain) continue;
      const h = this.health.get(brainKey(choice));
      (h?.until && h.until > now ? cooling : ready).push(brain);
    }
    return [...ready, ...cooling];
  }

  markOk(brain: { provider: string; model: string }): void {
    this.#load();
    const key = brainKey(brain);
    const was = this.health.get(key);
    this.health.set(key, { ok: true, checked_at: Date.now() });
    if (!was?.ok) this.#save();
  }

  /**
   * Cools a brain down. A slow start keeps it out of the way for 2 minutes,
   * doubling each time in a row up to half an hour, since a slow provider tends
   * to stay slow; other failures start at a minute. Running out of usage (429)
   * waits 15 minutes, and a bad key or unknown model 10.
   */
  markFailed(brain: { provider: string; model: string }, err: unknown): Health {
    this.#load();
    const now = Date.now();
    const key = brainKey(brain);
    const reason = err instanceof Error ? err.message : String(err);
    const was = this.health.get(key);
    const strikes = (was && !was.ok ? (was.strikes ?? 1) : 0) + 1;
    const twice = 2 ** Math.min(strikes - 1, 4);
    let cool = Math.min(MINUTE * twice, 15 * MINUTE);
    if (err instanceof SlowBrainError) cool = Math.min(2 * MINUTE * twice, 30 * MINUTE);
    else if (err instanceof BrainError && err.status === 429) cool = 15 * MINUTE;
    else if (err instanceof BrainError && err.permanent) cool = 10 * MINUTE;
    const h: Health = { ok: false, reason, checked_at: now, until: now + cool, strikes };
    this.health.set(key, h);
    this.#save();
    return h;
  }

  snapshot(): Record<string, { ok: boolean; reason?: string; checked_at: number }> {
    this.#load();
    const out: Record<string, { ok: boolean; reason?: string; checked_at: number }> = {};
    for (const [k, h] of this.health) out[k] = { ok: h.ok, reason: h.reason, checked_at: h.checked_at };
    return out;
  }

  #load(): void {
    if (this.#loaded || !this.store) return;
    this.#loaded = true;
    for (const [k, h] of Object.entries(this.store.load() ?? {})) if (!this.health.has(k)) this.health.set(k, h);
  }

  #save(): void {
    this.store?.save(Object.fromEntries(this.health));
  }
}
