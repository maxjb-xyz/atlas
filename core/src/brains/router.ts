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
}

export type MakeBrain = (choice: BrainChoice) => Brain | null;

export class BrainRouter {
  readonly health = new Map<string, Health>();

  constructor(private readonly make: MakeBrain) {}

  /**
   * The brains to try, in order. Unconfigured ones (ChatGPT signed out) are
   * left out. Ones cooling down after a failure go last rather than vanishing,
   * so a chain whose every brain failed recently still gets one more try.
   */
  chain(choices: BrainChoice[], now = Date.now()): Brain[] {
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
    this.health.set(brainKey(brain), { ok: true, checked_at: Date.now() });
  }

  markFailed(brain: { provider: string; model: string }, err: unknown): Health {
    const now = Date.now();
    const reason = err instanceof Error ? err.message : String(err);
    let cool = 60_000;
    if (err instanceof BrainError && err.status === 429) cool = 15 * 60_000;
    else if (err instanceof BrainError && err.permanent) cool = 10 * 60_000;
    const h: Health = { ok: false, reason, checked_at: now, until: now + cool };
    this.health.set(brainKey(brain), h);
    return h;
  }

  snapshot(): Record<string, { ok: boolean; reason?: string; checked_at: number }> {
    const out: Record<string, { ok: boolean; reason?: string; checked_at: number }> = {};
    for (const [k, h] of this.health) out[k] = { ok: h.ok, reason: h.reason, checked_at: h.checked_at };
    return out;
  }
}
