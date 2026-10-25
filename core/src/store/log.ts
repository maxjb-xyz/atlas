// One log (VISION §4.2): every message, tool call, receipt, record change,
// agenda change and delivery is a row. Rows are only ever appended.

import type { StageView } from "../stage";
import { type Json, newId, parse, type Sql } from "./db";

export type Actor = "owner" | "atlas" | "system";
/** Where a run was asked: the app, a call, the API, a chat channel (§16.1), or nowhere (Atlas's own). */
export type Surface = "app" | "voice" | "api" | "chat" | "none";

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
  | "settings.change"
  /** Atlas's summary of the conversation before a point, which replaces it in context (§4.1). */
  | "context.summary"
  /** What a helper handed back when its job ended (§8.1). */
  | "job.result"
  /** A coding job's question for the owner (§8.2), which Inbox shows until it's answered. */
  | "job.question"
  /** An area was created, changed, merged or archived, or the owner moved an item's areas (§6). */
  | "area.change"
  /** An automation was made, changed, turned on or paused, or deleted (§13). */
  | "automation.change"
  /** An automation ran, or ran as a test: each step's result, how long, and what it cost (§13.4). */
  | "automation.run"
  /** Something left Atlas on a channel beyond the thread (a push, a webhook call), or was held or refused at the exit (§4.4). */
  | "delivery"
  /** A page was made, given a new version, or deleted (§21.7). */
  | "page.change"
  /** A file was made, replaced or deleted (§21.7). */
  | "file.change"
  /** A skill was learned, patched, archived or brought back (§9.3). */
  | "skill.change"
  /** An event on the owner's calendar was changed from Atlas: moved back by Undo (§12.1). */
  | "calendar.change"
  /** A face's conversations (§7.2): what someone said to a face, what it said back (or the owner, from Inbox). */
  | "face.in"
  | "face.out"
  /** What a face handed the owner: a message it took, or a pull-in. Inbox shows it. */
  | "face.handoff"
  /** The faces' daily digest, for Inbox. */
  | "face.digest"
  /** Something a sense noticed (§10.1): arriving at or leaving a place, a real move, location turned off or on. */
  | "sense"
  /** What awareness made of a sense event or a rhythm moment (§10.3): stopped by a rule, decided not to matter, or woke Atlas, and what it chose; and the owner's reaction to a nudge. */
  | "awareness";

/** A receipt: the one-line chip the console shows for something Atlas did (§21.1). */
export interface Receipt {
  text: string;
  undo?: Undo;
  /** The stage view this receipt opens (§21.6), when Atlas showed one. */
  view?: StageView;
  /** The approval this receipt waits on (§12), which Review opens. */
  approval?: string;
}

/** What Undo on a receipt does. `history` names the correction to roll back. */
export type Undo =
  | { kind: "reminder.cancel"; id: string }
  | { kind: "record.forget"; id: string }
  | { kind: "record.restore"; id: string }
  | { kind: "record.revert"; id: string; history: number }
  /** Undoes a page's version `version`: back to the one before, or no page when it was the first. */
  | { kind: "page.undo"; id: string; version: number }
  /** Undoes a skill's version `version`: back to the one before, or archived when it was the first. */
  | { kind: "skill.undo"; id: string; version: number }
  /** Brings back a skill the review merged into another (§9.3). */
  | { kind: "skill.restore"; id: string }
  /** Moves a calendar event back to where it was. */
  | { kind: "calendar.move"; id: string; title: string; start: string; end: string }
  /** Takes off the calendar an event Atlas added. */
  | { kind: "calendar.remove"; id: string; title: string }
  /** Puts Speaking up back the way it was before Atlas changed it. */
  | { kind: "speaking.restore"; before: unknown }
  /** Puts back settings Atlas changed when asked: each changed setting as it was. */
  | { kind: "settings.restore"; before: Json }
  /** Puts back which account new mail goes from: the owner's default (no area) or one area's. */
  | { kind: "account.restore"; area: string | null; before: string }
  /** Takes back an extension tool's change (§17): its `undo` tool, with the input the call gave back for it. */
  | { kind: "tool.undo"; ext: string; tool: string; name: string; input: Json };

/** What a source says happened, as the intake keeps it in a `sense` row (§10.4). Sources add their own fields beside these (a place, a device, an event). */
export interface SenseItem {
  /** Where it came from: "location", "device", "calendar", "situation", "webhook". */
  source: string;
  event: string;
  /** What happened, in a line, for History, `decide` and Atlas. */
  what: string;
  /** The same key again within a while is the same news (a place's edge, a device flickering, a webhook sent twice). */
  key?: string;
  /** The thing it belongs to: an event's id, a place, a device, an issue. */
  thread?: string;
  /** Who it's from, when it's from someone. */
  from?: string;
  /** Who else it's with or about, as lines ("Doug Henderson <doug@acme.com>"): an event's organizer and those invited. */
  people?: string[];
  /** The source's own signals, for cheap rules: "review_requested", "assigned", "newsletter". */
  signals?: string[];
  link?: string;
  [field: string]: unknown;
}

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

/** A log writer for the loop, over this agent's own log. */
export const logTo =
  (sql: Sql) =>
  async (row: Append): Promise<LogRow> =>
    append(sql, row);

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
/** Runs whose failure the thread and the Inbox don't show on their own. */
export function quietTrigger(trigger: string): boolean {
  // An automation's failure reaches the thread as its own report ("… didn't run"), so its run's end stays quiet.
  return trigger === "compaction" || trigger === "areas" || trigger.startsWith("helper:") || trigger.startsWith("automation");
}

export function isThreadRow(row: LogRow): boolean {
  if (row.kind === "message.in" || row.kind === "message.out" || row.kind === "brain.fallback" || row.kind === "voice.problem") return true;
  if (row.kind === "tool.result") return row.body.receipt != null;
  // Atlas's own upkeep (compaction, area discovery) failing isn't news for the thread; the run and the
  // Worker log say why. A helper's failure reaches the thread as Atlas's report of it.
  if (row.kind === "run.end") return row.body.state === "failed" && !quietTrigger(String(row.body.trigger ?? ""));
  // An approval's answer (yes, no, or ran out) is said in the thread, so the owner hears what did and didn't happen (§12.2).
  if (row.kind === "agenda.change" && row.body.kind === "approval")
    return ["done", "cancelled", "failed"].includes(String(row.body.change));
  // An undo from a receipt shows as its own line, so the thread tells the truth.
  if (row.kind === "agenda.change" || row.kind === "record.change") return row.body.undo_of != null;
  // Atlas starting an area is said once, in the thread (§6.3).
  if (row.kind === "area.change") return row.body.change === "started";
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
  "area.change",
  "voice.problem",
];

export function thread(sql: Sql, limit: number, beforeSeq?: number): LogRow[] {
  // Some rows of these kinds aren't shown (tool results without receipts, record changes
  // that aren't undos), so read back in pages until there are enough or none are left.
  const out: LogRow[] = [];
  let before = beforeSeq;
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const rows = recent(sql, THREAD_KINDS, limit * 3, before);
    out.unshift(...rows.filter(isThreadRow));
    if (rows.length < limit * 3) break;
    before = rows[0]!.seq;
  }
  return out.slice(-limit);
}
