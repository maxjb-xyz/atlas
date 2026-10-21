// One log (VISION §4.2): every message, tool call, receipt, record change,
// agenda change and delivery is a row. Rows are only ever appended.

import { type Json, newId, parse, type Sql } from "./db";

export type Actor = "owner" | "atlas" | "system";
export type Surface = "app" | "voice" | "api" | "none";

export type LogKind =
  | "message.in"
  | "message.out"
  | "tool.call"
  | "tool.result"
  | "record.change"
  | "agenda.change"
  | "run.end"
  | "brain.fallback"
  | "voice.metrics"
  | "voice.problem"
  | "settings.change";

/** A receipt: the one-line chip the console shows for something Atlas did (§21.1). */
export interface Receipt {
  text: string;
  undo?: Undo;
}

/** What Undo on a receipt does. `history` names the correction to roll back. */
export type Undo =
  | { kind: "reminder.cancel"; id: string }
  | { kind: "record.forget"; id: string }
  | { kind: "record.restore"; id: string }
  | { kind: "record.revert"; id: string; history: number };

export interface LogRow {
  seq: number;
  id: string;
  at: number;
  actor: Actor;
  run_id: string | null;
  kind: LogKind;
  surface: Surface | null;
  areas: string[];
  privacy: string;
  body: Record<string, Json>;
}

export interface Append {
  actor: Actor;
  kind: LogKind;
  run_id?: string | null;
  surface?: Surface | null;
  areas?: string[];
  privacy?: string;
  body?: Record<string, unknown>;
  at?: number;
}

type RawRow = {
  seq: number;
  id: string;
  at: number;
  actor: string;
  run_id: string | null;
  kind: string;
  surface: string | null;
  areas: string;
  privacy: string;
  body: string;
};

function fromRaw(r: RawRow): LogRow {
  return {
    seq: r.seq,
    id: r.id,
    at: r.at,
    actor: r.actor as Actor,
    run_id: r.run_id,
    kind: r.kind as LogKind,
    surface: r.surface as Surface | null,
    areas: parse(r.areas, []),
    privacy: r.privacy,
    body: parse(r.body, {}),
  };
}

export function append(sql: Sql, row: Append): LogRow {
  const id = newId("lg");
  const at = row.at ?? Date.now();
  sql.exec(
    `INSERT INTO log (id, at, actor, run_id, kind, surface, areas, privacy, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    at,
    row.actor,
    row.run_id ?? null,
    row.kind,
    row.surface ?? null,
    JSON.stringify(row.areas ?? []),
    row.privacy ?? "private",
    JSON.stringify(row.body ?? {}),
  );
  return get(sql, id)!;
}

export function get(sql: Sql, id: string): LogRow | null {
  const r = sql.exec<RawRow>(`SELECT * FROM log WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

/** Rows of the given kinds, newest `limit`, returned oldest first. */
export function recent(sql: Sql, kinds: LogKind[], limit: number, beforeSeq?: number): LogRow[] {
  const marks = kinds.map(() => "?").join(", ");
  const rows = sql
    .exec<RawRow>(
      `SELECT * FROM log WHERE kind IN (${marks}) AND seq < ? ORDER BY seq DESC LIMIT ?`,
      ...kinds,
      beforeSeq ?? Number.MAX_SAFE_INTEGER,
      limit,
    )
    .toArray();
  return rows.reverse().map(fromRaw);
}

export function forRun(sql: Sql, runId: string): LogRow[] {
  return sql.exec<RawRow>(`SELECT * FROM log WHERE run_id = ? ORDER BY seq`, runId).toArray().map(fromRaw);
}

/** What the thread shows: messages, receipts, fallbacks and failed runs. */
export function isThreadRow(row: LogRow): boolean {
  if (row.kind === "message.in" || row.kind === "message.out" || row.kind === "brain.fallback" || row.kind === "voice.problem") return true;
  if (row.kind === "tool.result") return row.body.receipt != null;
  if (row.kind === "run.end") return row.body.state === "failed";
  // An undo from a receipt shows as its own line, so the thread tells the truth.
  if (row.kind === "agenda.change" || row.kind === "record.change") return row.body.undo_of != null;
  return false;
}

export const THREAD_KINDS: LogKind[] = [
  "message.in",
  "message.out",
  "tool.result",
  "brain.fallback",
  "run.end",
  "agenda.change",
  "record.change",
  "voice.problem",
];

export function thread(sql: Sql, limit: number, beforeSeq?: number): LogRow[] {
  // Over-fetch, since some tool.result and run.end rows aren't shown.
  return recent(sql, THREAD_KINDS, limit * 3, beforeSeq)
    .filter(isThreadRow)
    .slice(-limit);
}
