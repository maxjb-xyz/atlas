// Records (VISION §5.1): typed, curated knowledge, each with its source, when
// it was learned, a confidence and area tags. Corrections replace the
// current value and keep the old one in history. Forgetting takes a record
// out of what Atlas uses; the log still shows it was saved and forgotten.
// Every change keeps the memory index in step, so recall sees it at once.

import { append } from "./log";
import { type Json, newId, parse, type Sql } from "./db";
import { dropMemory, putMemory } from "./memory";

export const RECORD_TYPES = [
  "person",
  "place",
  "organization",
  "event",
  "task",
  "goal",
  "note",
  "preference",
  "commitment",
  "document",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const LINK_KINDS = ["about", "works_with", "part_of", "lives_at", "related"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface RecordSource {
  /** The log row this was learned from, when there is one. */
  log_id?: string;
  /** Messages that corrected it since, so forgetting it takes them out of recall too. */
  also?: string[];
  run_id?: string;
  /** Where it came from in plain words: "setup", "chat", "calendar". */
  via: string;
}

export interface AtlasRecord {
  id: string;
  type: RecordType;
  name: string;
  /** Structured details. `fact` holds the thing itself in one plain sentence. */
  fields: Record<string, Json>;
  source: RecordSource;
  learned_at: number;
  updated_at: number;
  confidence: number;
  areas: string[];
  visibility: string;
  state: "active" | "forgotten";
  /** How often recall has returned it; used ones rank higher (§5.3). */
  recalled: number;
}

type RawRecord = {
  id: string;
  type: string;
  name: string;
  fields: string;
  source: string;
  learned_at: number;
  updated_at: number;
  confidence: number;
  areas: string;
  visibility: string;
  state: string;
  recalled: number;
};

function fromRaw(r: RawRecord): AtlasRecord {
  return {
    id: r.id,
    type: r.type as RecordType,
    name: r.name,
    fields: parse(r.fields, {}),
    source: parse(r.source, { via: "unknown" }),
    learned_at: r.learned_at,
    updated_at: r.updated_at,
    confidence: r.confidence,
    areas: parse(r.areas, []),
    visibility: r.visibility,
    state: r.state === "forgotten" ? "forgotten" : "active",
    recalled: r.recalled,
  };
}

export function getRecord(sql: Sql, id: string): AtlasRecord | null {
  const r = sql.exec<RawRecord>(`SELECT * FROM records WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

/** Active records of a type, newest first, optionally by exact name (any case). */
export function findRecords(sql: Sql, type: RecordType, name?: string): AtlasRecord[] {
  const rows = name
    ? sql.exec<RawRecord>(
        `SELECT * FROM records WHERE state = 'active' AND type = ? AND lower(name) = lower(?) ORDER BY updated_at DESC`,
        type,
        name,
      )
    : sql.exec<RawRecord>(`SELECT * FROM records WHERE state = 'active' AND type = ? ORDER BY updated_at DESC`, type);
  return rows.toArray().map(fromRaw);
}

/** Active records whose name contains `text` (any case), most used first. */
export function recordsNamed(sql: Sql, text: string, limit = 10): AtlasRecord[] {
  return sql
    .exec<RawRecord>(
      `SELECT * FROM records WHERE state = 'active' AND instr(lower(name), lower(?)) > 0 ORDER BY recalled DESC, updated_at DESC LIMIT ?`,
      text,
      limit,
    )
    .toArray()
    .map(fromRaw);
}

/** What the memory index holds for a record: its name, the fact and its details. */
export function recordText(r: Pick<AtlasRecord, "type" | "name" | "fields">): string {
  const { fact, ...rest } = r.fields;
  const details = Object.entries(rest)
    .filter(([k]) => k !== "is_owner")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return [`${r.name} (${r.type})`, typeof fact === "string" ? fact : "", details.join("; ")].filter(Boolean).join(". ");
}

function reindex(sql: Sql, r: AtlasRecord): void {
  if (r.state === "active") putMemory(sql, { ref: `rec:${r.id}`, kind: "record", at: r.updated_at, text: recordText(r) });
  else dropMemory(sql, `rec:${r.id}`);
}

export interface NewRecord {
  type: RecordType;
  name: string;
  fields?: Record<string, Json>;
  source: RecordSource;
  confidence?: number;
  areas?: string[];
}

export function createRecord(sql: Sql, rec: NewRecord): AtlasRecord {
  const id = newId("rec");
  const now = Date.now();
  sql.exec(
    `INSERT INTO records (id, type, name, fields, source, learned_at, updated_at, confidence, areas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    rec.type,
    rec.name,
    JSON.stringify(rec.fields ?? {}),
    JSON.stringify(rec.source),
    now,
    now,
    rec.confidence ?? 1,
    JSON.stringify(rec.areas ?? []),
  );
  const created = getRecord(sql, id)!;
  reindex(sql, created);
  append(sql, {
    actor: "atlas",
    kind: "record.change",
    run_id: rec.source.run_id ?? null,
    body: { record_id: id, type: rec.type, name: rec.name, change: "created", after: created.fields },
  });
  return created;
}

export interface Correction {
  /** A new name, when the record itself changed (Vegetarian → Pescatarian). */
  name?: string;
  /** Fields to set. Null removes a field. */
  fields?: Record<string, Json>;
}

/**
 * A correction replaces the current values, and the old values stay in
 * history (§5.1). Returns the history entry, so the change can be undone.
 */
export function correctRecord(
  sql: Sql,
  id: string,
  c: Correction,
  reason: string,
  source: RecordSource,
  extra: Record<string, unknown> = {},
): AtlasRecord & { history_seq: number } {
  const before = getRecord(sql, id);
  if (!before) throw new Error(`no record ${id}`);
  const fields: Record<string, Json> = { ...before.fields };
  for (const [k, v] of Object.entries(c.fields ?? {})) {
    if (v === null) delete fields[k];
    else fields[k] = v;
  }
  const name = c.name?.trim() || before.name;
  // Where it was first learned stays its source; the correction's message joins `also`.
  const kept: RecordSource = { ...before.source };
  if (source.log_id && source.log_id !== kept.log_id && !kept.also?.includes(source.log_id)) {
    kept.also = [...(kept.also ?? []), source.log_id];
  }
  const now = Date.now();
  sql.exec(
    `INSERT INTO record_history (record_id, at, fields, reason, name) VALUES (?, ?, ?, ?, ?)`,
    id,
    now,
    JSON.stringify(before.fields),
    reason,
    before.name,
  );
  const seq = sql.exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`).one().seq;
  sql.exec(
    `UPDATE records SET name = ?, fields = ?, source = ?, updated_at = ? WHERE id = ?`,
    name,
    JSON.stringify(fields),
    JSON.stringify(kept),
    now,
    id,
  );
  const after = getRecord(sql, id)!;
  reindex(sql, after);
  append(sql, {
    actor: source.via === "owner" ? "owner" : "atlas",
    kind: "record.change",
    run_id: source.run_id ?? null,
    body: {
      record_id: id,
      type: before.type,
      name,
      change: "corrected",
      ...(source.log_id ? { from_log: source.log_id } : {}),
      ...(name !== before.name ? { was: before.name } : {}),
      before: before.fields,
      after: fields,
      reason,
      ...(extra as Record<string, Json>),
    },
  });
  return { ...after, history_seq: seq };
}

/**
 * Puts a record back as it was before a correction: the undo of a
 * correction. Returns null if the record changed or was forgotten since,
 * so a later change is never silently lost.
 */
export function revertRecord(
  sql: Sql,
  id: string,
  historySeq: number,
  source: RecordSource,
  extra: Record<string, unknown> = {},
): AtlasRecord | null {
  const h = sql
    .exec<{ at: number; fields: string; name: string | null }>(
      `SELECT at, fields, name FROM record_history WHERE seq = ? AND record_id = ?`,
      historySeq,
      id,
    )
    .toArray()[0];
  const current = getRecord(sql, id);
  if (!h || !current || current.state !== "active" || current.updated_at !== h.at) return null;
  const old = parse<Record<string, Json>>(h.fields, {});
  const patch: Record<string, Json> = { ...old };
  for (const k of Object.keys(current.fields)) if (!(k in old)) patch[k] = null;
  return correctRecord(sql, id, { name: h.name ?? current.name, fields: patch }, "undone", source, extra);
}

/**
 * Takes a record out of what Atlas knows and uses. The message it came from
 * leaves the recall index too, so recall doesn't bring it back; the log keeps
 * both, and History shows the save and the forget.
 */
export function forgetRecord(sql: Sql, id: string, source: RecordSource, extra: Record<string, unknown> = {}): AtlasRecord | null {
  return setRecordState(sql, id, "forgotten", source, extra);
}

/** Brings a forgotten record back: the undo of a forget. */
export function restoreRecord(sql: Sql, id: string, source: RecordSource, extra: Record<string, unknown> = {}): AtlasRecord | null {
  return setRecordState(sql, id, "active", source, extra);
}

function setRecordState(
  sql: Sql,
  id: string,
  state: AtlasRecord["state"],
  source: RecordSource,
  extra: Record<string, unknown>,
): AtlasRecord | null {
  const before = getRecord(sql, id);
  if (!before || before.state === state) return null;
  sql.exec(`UPDATE records SET state = ?, updated_at = ? WHERE id = ?`, state, Date.now(), id);
  const after = getRecord(sql, id)!;
  reindex(sql, after);
  for (const from of [before.source.log_id, ...(before.source.also ?? [])]) {
    if (!from) continue;
    if (state === "forgotten") dropMemory(sql, `log:${from}`);
    else {
      const row = sql.exec<{ at: number; body: string }>(`SELECT at, body FROM log WHERE id = ?`, from).toArray()[0];
      const text = row ? parse<Record<string, Json>>(row.body, {}).text : null;
      if (row && typeof text === "string") putMemory(sql, { ref: `log:${from}`, kind: "message", at: row.at, text });
    }
  }
  append(sql, {
    actor: source.via === "owner" ? "owner" : "atlas",
    kind: "record.change",
    run_id: source.run_id ?? null,
    body: {
      record_id: id,
      type: before.type,
      name: before.name,
      change: state === "forgotten" ? "forgotten" : "restored",
      ...(extra as Record<string, Json>),
    },
  });
  return after;
}

export function recordHistory(
  sql: Sql,
  id: string,
): Array<{ at: number; name: string | null; fields: Record<string, Json>; reason: string }> {
  return sql
    .exec<{ at: number; name: string | null; fields: string; reason: string }>(
      `SELECT at, name, fields, reason FROM record_history WHERE record_id = ? ORDER BY seq`,
      id,
    )
    .toArray()
    .map((r) => ({ at: r.at, name: r.name, fields: parse(r.fields, {}), reason: r.reason }));
}

/** Records that use most often get found first (§5.3). */
export function markRecalled(sql: Sql, ids: string[]): void {
  for (const id of ids) sql.exec(`UPDATE records SET recalled = recalled + 1 WHERE id = ?`, id);
}

// --- links ------------------------------------------------------------------

export function link(sql: Sql, from: string, to: string, kind: LinkKind): void {
  if (from === to) return;
  sql.exec(`INSERT OR IGNORE INTO links (from_id, to_id, kind, at) VALUES (?, ?, ?, ?)`, from, to, kind, Date.now());
}

/** Active records linked to `id`, either way. */
export function linked(sql: Sql, id: string): Array<{ record: AtlasRecord; kind: LinkKind }> {
  return sql
    .exec<RawRecord & { link_kind: string }>(
      `SELECT r.*, l.kind AS link_kind FROM links l JOIN records r ON r.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id = ? OR l.to_id = ?) AND r.state = 'active'`,
      id,
      id,
      id,
    )
    .toArray()
    .map((r) => ({ record: fromRaw(r), kind: r.link_kind as LinkKind }));
}

// --- the owner ---------------------------------------------------------------

/** The owner's own person record, created on first use. */
export function ownerRecord(sql: Sql): AtlasRecord {
  const existing = sql
    .exec<RawRecord>(`SELECT * FROM records WHERE type = 'person' AND json_extract(fields, '$.is_owner') = 1 LIMIT 1`)
    .toArray()[0];
  if (existing) return fromRaw(existing);
  return createRecord(sql, { type: "person", name: "Owner", fields: { is_owner: true }, source: { via: "setup" } });
}

/** What the owner is called: the name in their settings, else their record's, else empty. */
export function ownerName(sql: Sql): string {
  const r = sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'owner_name'`).toArray()[0];
  const set = r ? (JSON.parse(r.value) as unknown) : null;
  if (typeof set === "string" && set.trim()) return set.trim();
  const rec = ownerRecord(sql).name;
  return rec && rec !== "Owner" ? rec : "";
}

/**
 * Standing facts about the owner (§5.2): their preferences and what's noted
 * on their own record. These sit in the stable, cacheable block of every
 * run, oldest first so the block only grows at its end.
 */
export function standingFacts(sql: Sql, limit = STANDING_FACTS): AtlasRecord[] {
  return sql
    .exec<RawRecord>(
      `SELECT * FROM (
         SELECT * FROM records WHERE state = 'active' AND (type = 'preference' OR json_extract(fields, '$.is_owner') = 1)
         ORDER BY learned_at DESC LIMIT ?
       ) ORDER BY learned_at`,
      limit,
    )
    .toArray()
    .map(fromRaw);
}

/** The newest this many standing facts are in view; older ones are still found by recall. */
export const STANDING_FACTS = 100;

// --- deleting for good (§12.1: can't be undone) ----------------------------------

/**
 * Erases a record for good, at the owner's word: the record, its history,
 * its links and its place in recall, and its values in the log's record
 * changes and the tool calls that saved it. The log keeps that something was
 * deleted, not what it said. The owner's own message it came from stays: that
 * is the conversation, which only the owner deletes (§4.2, §23.4).
 */
export function deleteRecord(sql: Sql, id: string, source: RecordSource): string[] | null {
  const r = getRecord(sql, id);
  if (!r) return null;
  // The log rows rewritten below, so open apps can be sent the blanked versions.
  const touched = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE (kind = 'record.change' AND json_extract(body, '$.record_id') = ?) OR (kind = 'tool.result' AND json_extract(body, '$.receipt.undo.id') = ?)`,
      id,
      id,
    )
    .toArray()
    .map((x) => x.id);
  sql.exec(`DELETE FROM records WHERE id = ?`, id);
  sql.exec(`DELETE FROM record_history WHERE record_id = ?`, id);
  sql.exec(`DELETE FROM links WHERE from_id = ? OR to_id = ?`, id, id);
  dropMemory(sql, `rec:${id}`);
  sql.exec(
    `UPDATE log SET body = json_object('record_id', ?, 'type', json_extract(body, '$.type'), 'change', json_extract(body, '$.change'), 'name', '[deleted]', 'deleted', 1)
     WHERE kind = 'record.change' AND json_extract(body, '$.record_id') = ?`,
    id,
    id,
  );
  // The calls that saved or changed it: their receipts point at it by id.
  const calls = sql
    .exec<{ run_id: string | null; call_id: string }>(
      `SELECT run_id, json_extract(body, '$.call_id') AS call_id FROM log WHERE kind = 'tool.result' AND json_extract(body, '$.receipt.undo.id') = ?`,
      id,
    )
    .toArray();
  for (const c of calls) {
    sql.exec(
      `UPDATE log SET body = json_object('call_id', ?, 'name', json_extract(body, '$.name'), 'ok', json_extract(body, '$.ok'), 'output', '[deleted]', 'receipt', json_object('text', 'Deleted for good'))
       WHERE kind = 'tool.result' AND run_id IS ? AND json_extract(body, '$.call_id') = ?`,
      c.call_id,
      c.run_id,
      c.call_id,
    );
    sql.exec(
      `UPDATE log SET body = json_object('call_id', ?, 'name', json_extract(body, '$.name'), 'input', json_object())
       WHERE kind = 'tool.call' AND run_id IS ? AND json_extract(body, '$.call_id') = ?`,
      c.call_id,
      c.run_id,
      c.call_id,
    );
  }
  append(sql, {
    actor: "owner",
    kind: "record.change",
    run_id: source.run_id ?? null,
    body: { record_id: id, type: r.type, change: "deleted", name: "[deleted]", deleted: true },
  });
  return touched;
}
