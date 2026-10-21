// The memory index (§5.3): every message and every active record, searchable
// by keyword (SQLite full-text search) and by meaning (an embedding stored
// beside the text). It lives in the person's own agent, like the rest of
// their memory. The log stays the permanent record; this is only an index,
// so dropping an item here never loses anything.

import { parse, type Sql } from "./db";
import type { LogRow } from "./log";
import { getState, setState } from "./state";

export type MemoryKind = "message" | "record";

export interface MemoryItem {
  /** `log:<id>` for a message, `rec:<id>` for a record. */
  ref: string;
  kind: MemoryKind;
  at: number;
  text: string;
}

export interface Hit {
  ref: string;
  kind: MemoryKind;
  at: number;
  score: number;
}

export interface Range {
  from?: number;
  to?: number;
  kinds?: MemoryKind[];
}

/** Meaning search compares against at most this many recent items when no time range narrows it. */
export const MEANING_SCAN = 5_000;

/**
 * Meaning matches must be at least this similar (cosine), and within
 * MEANING_SPREAD of the best one, so a query with no real match returns
 * nothing instead of the least-bad items. Check both against real
 * EmbeddingGemma scores on the deployment (M1.md §1, step 13).
 */
export const MEANING_FLOOR = 0.3;
export const MEANING_SPREAD = 0.2;

/** Adds or updates an item. Changed text needs a new embedding. */
export function putMemory(sql: Sql, item: MemoryItem): void {
  const old = sql.exec<{ text: string }>(`SELECT text FROM memory WHERE ref = ?`, item.ref).toArray()[0];
  if (old && old.text === item.text) {
    sql.exec(`UPDATE memory SET at = ? WHERE ref = ?`, item.at, item.ref);
    return;
  }
  sql.exec(
    `INSERT OR REPLACE INTO memory (ref, kind, at, text, model, vec) VALUES (?, ?, ?, ?, NULL, NULL)`,
    item.ref,
    item.kind,
    item.at,
    item.text,
  );
  sql.exec(`DELETE FROM memory_fts WHERE ref = ?`, item.ref);
  sql.exec(`INSERT INTO memory_fts (ref, text) VALUES (?, ?)`, item.ref, item.text);
}

export function dropMemory(sql: Sql, ref: string): void {
  sql.exec(`DELETE FROM memory WHERE ref = ?`, ref);
  sql.exec(`DELETE FROM memory_fts WHERE ref = ?`, ref);
}

export function getMemory(sql: Sql, ref: string): MemoryItem | null {
  const r = sql
    .exec<{ ref: string; kind: string; at: number; text: string }>(`SELECT ref, kind, at, text FROM memory WHERE ref = ?`, ref)
    .toArray()[0];
  return r ? { ...r, kind: r.kind as MemoryKind } : null;
}

const STOP = new Set(
  "a an and are as at be but by did do does for from had has have how i i'm in is it its me my of on or our so that the their them then there they this to was we were what when where which who why will with you your about any anything".split(
    " ",
  ),
);

/** The words worth matching, quoted for FTS5 so punctuation can't break the query. */
export function keywords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOP.has(w)))];
}

function where(range: Range): { clause: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (range.from != null) {
    parts.push(`m.at >= ?`);
    args.push(range.from);
  }
  if (range.to != null) {
    parts.push(`m.at < ?`);
    args.push(range.to);
  }
  if (range.kinds?.length) {
    parts.push(`m.kind IN (${range.kinds.map(() => "?").join(", ")})`);
    args.push(...range.kinds);
  }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", args };
}

/** Best keyword matches first. Any of the words may match; more and rarer matches rank higher. */
export function keywordSearch(sql: Sql, query: string, range: Range, limit = 50): Hit[] {
  const words = keywords(query);
  if (!words.length) return [];
  const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  const w = where(range);
  return sql
    .exec<{ ref: string; kind: string; at: number; s: number }>(
      `SELECT m.ref AS ref, m.kind AS kind, m.at AS at, bm25(memory_fts) AS s
       FROM memory_fts JOIN memory m ON m.ref = memory_fts.ref
       WHERE memory_fts MATCH ?${w.clause} ORDER BY s LIMIT ?`,
      match,
      ...w.args,
      limit,
    )
    .toArray()
    .map((r) => ({ ref: r.ref, kind: r.kind as MemoryKind, at: r.at, score: -r.s }));
}

/** Items closest in meaning to `vec`, from those embedded with `model`. */
export function meaningSearch(sql: Sql, vec: Float32Array, model: string, range: Range, limit = 50): Hit[] {
  const w = where(range);
  const narrowed = range.from != null || range.to != null;
  const rows = sql
    .exec<{ ref: string; kind: string; at: number; vec: ArrayBuffer }>(
      `SELECT m.ref AS ref, m.kind AS kind, m.at AS at, m.vec AS vec FROM memory m
       WHERE m.model = ?${w.clause} ORDER BY m.at DESC LIMIT ?`,
      model,
      ...w.args,
      narrowed ? Number.MAX_SAFE_INTEGER : MEANING_SCAN,
    )
    .toArray();
  const hits: Hit[] = [];
  for (const r of rows) {
    const v = new Float32Array(r.vec);
    if (v.length !== vec.length) continue;
    hits.push({ ref: r.ref, kind: r.kind as MemoryKind, at: r.at, score: dot(vec, v) });
  }
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0]?.score ?? 0;
  return hits.filter((h) => h.score >= MEANING_FLOOR && h.score >= best - MEANING_SPREAD).slice(0, limit);
}

/** Items in a time range, newest first, for questions asked by time alone. */
export function inRange(sql: Sql, range: Range, limit = 40): Hit[] {
  const w = where(range);
  return sql
    .exec<{ ref: string; kind: string; at: number }>(
      `SELECT m.ref AS ref, m.kind AS kind, m.at AS at FROM memory m WHERE 1 = 1${w.clause} ORDER BY m.at DESC LIMIT ?`,
      ...w.args,
      limit,
    )
    .toArray()
    .map((r) => ({ ref: r.ref, kind: r.kind as MemoryKind, at: r.at, score: 0 }));
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Scales a vector to length 1, so comparing two is a dot product. */
export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const len = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / len;
  return out;
}

/** Items that still need an embedding from `model`, oldest first. */
export function unembedded(sql: Sql, model: string, limit: number): Array<{ ref: string; text: string }> {
  return sql
    .exec<{ ref: string; text: string }>(`SELECT ref, text FROM memory WHERE model IS NULL OR model != ? ORDER BY at LIMIT ?`, model, limit)
    .toArray();
}

export function setVector(sql: Sql, ref: string, model: string, vec: Float32Array): void {
  sql.exec(`UPDATE memory SET model = ?, vec = ? WHERE ref = ?`, model, vec.buffer as ArrayBuffer, ref);
}

/**
 * Adds messages logged since the last call. Runs after each run ends rather
 * than as each row is written, so it also catches up after a restart. A
 * message that was the source of a forgotten record stays out.
 */
export function indexNewMessages(sql: Sql): number {
  const since = getState<number>(sql, "memory_seq") ?? 0;
  const rows = sql
    .exec<{ seq: number; id: string; at: number; kind: string; body: string }>(
      `SELECT seq, id, at, kind, body FROM log WHERE seq > ? AND kind IN ('message.in', 'message.out') ORDER BY seq LIMIT 500`,
      since,
    )
    .toArray();
  let last = since;
  for (const r of rows) {
    last = r.seq;
    const text = parse<LogRow["body"]>(r.body, {}).text;
    if (typeof text !== "string" || !text.trim()) continue;
    const forgotten = sql
      .exec(`SELECT 1 FROM records WHERE state = 'forgotten' AND json_extract(source, '$.log_id') = ? LIMIT 1`, r.id)
      .toArray().length;
    if (forgotten) continue;
    putMemory(sql, { ref: `log:${r.id}`, kind: "message", at: r.at, text });
  }
  if (last !== since) setState(sql, "memory_seq", last);
  return rows.length;
}
