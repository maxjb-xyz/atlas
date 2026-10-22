// One clock (VISION §4.3). The agenda holds reminders, and since M1 the
// jobs helpers run in the background (§8.1). Since M2 it also holds
// notifications waiting for quiet hours to end (§14). Promises, automations
// and watches join in M2 as more kinds of the same row.

import { append } from "./log";
import { type Json, newId, parse, type Sql } from "./db";

export type AgendaKind = "reminder" | "job" | "notify" | "approval";
export type AgendaState = "scheduled" | "running" | "done" | "cancelled" | "failed";

export interface AgendaSource {
  run_id?: string;
  log_id?: string;
  via: string;
  /** What the item needs beyond its title: for a job, the helper's brief and run. */
  detail?: Record<string, Json>;
}

export interface AgendaItem {
  id: string;
  kind: AgendaKind;
  title: string;
  due_at: number;
  state: AgendaState;
  lease_until: number | null;
  schedule_id: string | null;
  source: AgendaSource;
  created_at: number;
  updated_at: number;
}

type RawItem = {
  id: string;
  kind: string;
  title: string;
  due_at: number;
  state: string;
  lease_until: number | null;
  schedule_id: string | null;
  source: string;
  created_at: number;
  updated_at: number;
};

function fromRaw(r: RawItem): AgendaItem {
  return { ...r, kind: r.kind as AgendaKind, state: r.state as AgendaState, source: parse(r.source, { via: "unknown" }) };
}

/** How long a fired item is held by one run before it can be picked up again. */
export const LEASE_MS = 5 * 60_000;

export function getItem(sql: Sql, id: string): AgendaItem | null {
  const r = sql.exec<RawItem>(`SELECT * FROM agenda WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function upcoming(sql: Sql, limit = 50): AgendaItem[] {
  return sql
    .exec<RawItem>(`SELECT * FROM agenda WHERE state IN ('scheduled', 'running') ORDER BY due_at LIMIT ?`, limit)
    .toArray()
    .map(fromRaw);
}

/** Items whose time has come and that nobody holds a live lease on. */
export function due(sql: Sql, now: number): AgendaItem[] {
  return sql
    .exec<RawItem>(
      `SELECT * FROM agenda WHERE (state = 'scheduled' AND due_at <= ?) OR (state = 'running' AND lease_until < ?) ORDER BY due_at`,
      now,
      now,
    )
    .toArray()
    .map(fromRaw);
}

export function createItem(
  sql: Sql,
  item: { kind: AgendaKind; title: string; due_at: number; source: AgendaSource; state?: "scheduled" | "running" },
): AgendaItem {
  const id = newId("ag");
  const now = Date.now();
  sql.exec(
    `INSERT INTO agenda (id, kind, title, due_at, state, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    item.kind,
    item.title,
    item.due_at,
    item.state ?? "scheduled",
    JSON.stringify(item.source),
    now,
    now,
  );
  append(sql, {
    actor: "atlas",
    kind: "agenda.change",
    run_id: item.source.run_id ?? null,
    body: { item_id: id, change: "created", kind: item.kind, title: item.title, due_at: item.due_at },
  });
  return getItem(sql, id)!;
}

export function setScheduleId(sql: Sql, id: string, scheduleId: string | null): void {
  sql.exec(`UPDATE agenda SET schedule_id = ?, updated_at = ? WHERE id = ?`, scheduleId, Date.now(), id);
}

/** Take the lease on a due item. Returns null if it isn't due or someone else holds it. */
export function lease(sql: Sql, id: string, now = Date.now()): AgendaItem | null {
  const item = getItem(sql, id);
  if (!item) return null;
  const free = item.state === "scheduled" || (item.state === "running" && (item.lease_until ?? 0) < now);
  if (!free || item.due_at > now) return null;
  sql.exec(`UPDATE agenda SET state = 'running', lease_until = ?, updated_at = ? WHERE id = ?`, now + LEASE_MS, now, id);
  return getItem(sql, id);
}

export function finish(
  sql: Sql,
  id: string,
  state: Extract<AgendaState, "done" | "cancelled" | "failed">,
  runId: string | null,
  detail: Record<string, unknown> = {},
): AgendaItem | null {
  const item = getItem(sql, id);
  if (!item) return null;
  sql.exec(`UPDATE agenda SET state = ?, lease_until = NULL, updated_at = ? WHERE id = ?`, state, Date.now(), id);
  append(sql, {
    actor: state === "cancelled" && detail.by === "owner" ? "owner" : "atlas",
    kind: "agenda.change",
    run_id: runId,
    body: { item_id: id, change: state, kind: item.kind, title: item.title, due_at: item.due_at, ...detail },
  });
  return getItem(sql, id);
}
