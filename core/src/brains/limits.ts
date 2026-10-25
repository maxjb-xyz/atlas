// What Atlas knows about each brain's health and limits (§18), as plain
// types the app can read too: the router keeps them, Settings shows them.

/**
 * What a plan says about its own limits, as its responses carry them: each
 * window's share used and when it resets (ChatGPT's plan, §18).
 */
export interface PlanLimits {
  windows: Array<{ name: string; used_percent: number; window_minutes?: number; resets_at?: number }>;
  seen_at: number;
}

export interface Health {
  ok: boolean;
  reason?: string;
  checked_at: number;
  /** Skip this brain until then. */
  until?: number;
  /** Failures in a row: each one keeps the brain out of the way for longer. */
  strikes?: number;
  /** When the provider said it can be used again (a plan's window, a cap). */
  resets_at?: number;
  /** Measured from Atlas's own runs: the time to its first word or lookup, and output tokens a second. */
  speed?: { first_ms: number; tps: number | null; runs: number };
  /** The plan's own limits, from its last answer (ChatGPT's plan). */
  limits?: PlanLimits;
}
