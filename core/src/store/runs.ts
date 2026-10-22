// Every run ends in exactly one saved final state: replied, deferred or
// failed (§4.1). A run left "running" by a crash is swept to failed, so
// nothing stays running forever.

import { append, type Actor, type Surface } from "./log";
import { newId, parse, type Sql } from "./db";

export type FinalState = "replied" | "deferred" | "failed";

export interface RunRow {
  id: string;
  actor: Actor;
  trigger: string;
  surface: Surface;
  role: string;
  state: "running" | FinalState;
  started_at: number;
  ended_at: number | null;
  steps: number;
  detail: Record<string, unknown>;
}

/** A run with no final state after this long was lost (a restart mid-turn). */
export const STALE_RUN_MS = 15 * 60_000;

export function startRun(sql: Sql, r: { actor: Actor; trigger: string; surface: Surface; role: string }): string {
  const id = newId("run");
  sql.exec(
    `INSERT INTO runs (id, actor, trigger, surface, role, state, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    id,
    r.actor,
    r.trigger,
    r.surface,
    r.role,
    Date.now(),
  );
  return id;
}

export function endRun(sql: Sql, id: string, state: FinalState, steps: number, detail: Record<string, unknown> = {}): void {
  const row = getRun(sql, id);
  if (!row || row.state !== "running") return;
  const now = Date.now();
  sql.exec(`UPDATE runs SET state = ?, ended_at = ?, steps = ?, detail = ? WHERE id = ?`, state, now, steps, JSON.stringify(detail), id);
  append(sql, {
    actor: "system",
    kind: "run.end",
    run_id: id,
    surface: row.surface,
    body: { state, steps, ms: now - row.started_at, trigger: row.trigger, ...detail },
  });
}

export function getRun(sql: Sql, id: string): RunRow | null {
  const r = sql.exec<Omit<RunRow, "detail"> & { detail: string }>(`SELECT * FROM runs WHERE id = ?`, id).toArray()[0];
  return r ? { ...r, detail: parse(r.detail, {}) } : null;
}

export function runningRuns(sql: Sql): RunRow[] {
  return sql
    .exec<Omit<RunRow, "detail"> & { detail: string }>(`SELECT * FROM runs WHERE state = 'running' ORDER BY started_at`)
    .toArray()
    .map((r) => ({ ...r, detail: parse(r.detail, {}) }));
}

/** Moves lost runs to failed. Pass 0 on startup: no run survives a restart of this instance. */
export function sweepStaleRuns(sql: Sql, olderThanMs = STALE_RUN_MS): number {
  const cutoff = Date.now() - olderThanMs;
  // A helper's run outlives a restart: its fiber carries on, and its job's lease decides when it's lost.
  const stale = runningRuns(sql).filter((r) => r.started_at <= cutoff && !r.trigger.startsWith("helper:"));
  for (const r of stale) endRun(sql, r.id, "failed", r.steps, { error: "Atlas restarted before this finished." });
  return stale.length;
}
