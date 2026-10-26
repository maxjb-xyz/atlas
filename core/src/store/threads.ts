// Threads (VISION §21.1, §21.4): conversations of their own, each about one
// piece of work or topic, that run side by side. Today is the line to Atlas
// itself and has no row here: a run with no thread is Today's.
//
// A thread holds no conversation of its own. Its runs say which thread they're
// in, and every row a run writes carries that (store/log.ts), so the one log
// stays the one log and a thread is a view of it.

import { newId, parse, type Sql } from "./db";
import { get as getRow, type LogRow } from "./log";

/** A thread nobody touched in this long leaves Recent; search still finds it, and a pinned one stays. */
export const QUIET_AFTER_MS = 3 * 24 * 3_600_000;

export interface Thread {
  id: string;
  title: string;
  /** The spaces (areas) it's in (§21.3): its runs wear their hat. */
  areas: string[];
  /** Whether Atlas has named it yet; until then its title is the start of its first message. */
  named: boolean;
  pinned: boolean;
  /** "open", or "archived" when the owner put it away. */
  state: "open" | "archived";
  created_at: number;
  last_at: number;
}

type Raw = Omit<Thread, "areas" | "named" | "pinned" | "state"> & { areas: string; named: number; pinned: number; state: string };

function fromRaw(r: Raw): Thread {
  return {
    ...r,
    areas: parse<string[]>(r.areas, []),
    named: r.named === 1,
    pinned: r.pinned === 1,
    state: r.state === "archived" ? "archived" : "open",
  };
}

/** A title from the start of what was said, until Atlas names the thread. */
export function provisionalTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 48) return t || "New thread";
  const cut = t.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 24 ? cut.lastIndexOf(" ") : 48)}…`;
}

export function createThread(sql: Sql, o: { title: string; areas?: string[]; named?: boolean }): Thread {
  const id = newId("th");
  const now = Date.now();
  sql.exec(
    `INSERT INTO threads (id, title, areas, named, pinned, state, created_at, last_at) VALUES (?, ?, ?, ?, 0, 'open', ?, ?)`,
    id,
    o.title.trim().slice(0, 120) || "New thread",
    JSON.stringify(o.areas ?? []),
    o.named ? 1 : 0,
    now,
    now,
  );
  return getThread(sql, id)!;
}

export function getThread(sql: Sql, id: string): Thread | null {
  const r = sql.exec<Raw>(`SELECT * FROM threads WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

/** Threads, the most recently active first. Archived ones only when asked. */
export function listThreads(sql: Sql, o: { archived?: boolean; limit?: number } = {}): Thread[] {
  return sql
    .exec<Raw>(`SELECT * FROM threads ${o.archived ? "" : "WHERE state = 'open'"} ORDER BY last_at DESC LIMIT ?`, o.limit ?? 200)
    .toArray()
    .map(fromRaw);
}

export function touchThread(sql: Sql, id: string, at = Date.now()): void {
  sql.exec(`UPDATE threads SET last_at = MAX(last_at, ?) WHERE id = ?`, at, id);
}

export function updateThread(
  sql: Sql,
  id: string,
  patch: Partial<Pick<Thread, "title" | "named" | "pinned" | "state" | "areas">>,
): Thread | null {
  const t = getThread(sql, id);
  if (!t) return null;
  const next = { ...t, ...patch };
  sql.exec(
    `UPDATE threads SET title = ?, named = ?, pinned = ?, state = ?, areas = ? WHERE id = ?`,
    next.title.trim().slice(0, 120) || t.title,
    next.named ? 1 : 0,
    next.pinned ? 1 : 0,
    next.state,
    JSON.stringify(next.areas),
    id,
  );
  return getThread(sql, id);
}

/**
 * Moves a run, and every row it wrote, to a thread (null: Today). The note that says where it went stays where it
 * was said, so Undo can be found there.
 */
export function moveRun(sql: Sql, runId: string, to: string | null): void {
  sql.exec(`UPDATE runs SET thread = ? WHERE id = ?`, to, runId);
  sql.exec(
    `UPDATE log SET thread = ? WHERE run_id = ? AND COALESCE(json_extract(body, '$.receipt.undo.kind'), '') != 'thread.move'`,
    to,
    runId,
  );
  if (to) touchThread(sql, to);
}

/** The thread a run is in, or null for Today. */
export function threadOfRun(sql: Sql, runId: string): string | null {
  return sql.exec<{ thread: string | null }>(`SELECT thread FROM runs WHERE id = ?`, runId).toArray()[0]?.thread ?? null;
}

/** The last thing said in a thread, by either side, in a line. */
export function lastSaid(sql: Sql, id: string): { text: string; by: "owner" | "atlas"; at: number } | null {
  const r = sql
    .exec<{ kind: string; at: number; body: string }>(
      `SELECT kind, at, body FROM log WHERE thread = ? AND kind IN ('message.in', 'message.out') ORDER BY seq DESC LIMIT 1`,
      id,
    )
    .toArray()[0];
  if (!r) return null;
  const text = String(parse<{ text?: unknown }>(r.body, {}).text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? { text: text.slice(0, 140), by: r.kind === "message.in" ? "owner" : "atlas", at: r.at } : null;
}

/** Threads with a run of theirs going now. */
export function busyThreads(sql: Sql): Set<string> {
  return new Set(
    sql
      .exec<{ thread: string }>(`SELECT DISTINCT thread FROM runs WHERE state = 'running' AND thread IS NOT NULL`)
      .toArray()
      .map((r) => r.thread),
  );
}

/**
 * One line per open thread, for every turn's context (§21.1): so "how's the Lisbon plan going?" works from anywhere,
 * and a message that continues one can go to it. `here` is the thread the turn is in.
 */
export function threadLines(sql: Sql, here: string | null, now = Date.now()): string {
  const open = listThreads(sql, { limit: 12 }).filter((t) => t.id !== here && (t.pinned || now - t.last_at < QUIET_AFTER_MS));
  if (!open.length) return "";
  const busy = busyThreads(sql);
  const lines = open.map((t) => {
    const last = lastSaid(sql, t.id);
    const what = busy.has(t.id)
      ? "you're answering in it now"
      : last
        ? `last, ${last.by === "owner" ? "the owner" : "you"}: "${last.text}"`
        : "nothing said yet";
    return `- "${t.title}" (thread ${t.id}): ${what}`;
  });
  return [
    here
      ? "The owner's other threads (each is its own conversation; you see only this one's messages):"
      : "The owner's open threads (each is its own conversation, apart from Today):",
    ...lines,
  ].join("\n");
}

/**
 * A space's feed (§21.3): what Atlas said in that area on its own (a nudge, a routine's report, a job's word), oldest
 * first. What the owner asked and Atlas answered is in Today or a thread, not here.
 */
export function spaceFeed(sql: Sql, area: string, limit = 50): LogRow[] {
  return sql
    .exec<{ id: string }>(
      `SELECT log.id FROM log JOIN runs ON runs.id = log.run_id
       WHERE log.kind IN ('message.out', 'job.result', 'job.question') AND runs.actor = 'atlas'
         AND EXISTS (SELECT 1 FROM json_each(log.areas) WHERE value = ?)
       ORDER BY log.seq DESC LIMIT ?`,
      area,
      limit,
    )
    .toArray()
    .reverse()
    .map((r) => getRow(sql, r.id))
    .filter((r): r is LogRow => r != null);
}
