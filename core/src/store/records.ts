// Minimal records (VISION §5.1). M0 has the table shape, sources and
// corrections with history. Recall, collections and links come in M1.

import { append } from "./log";
import { type Json, newId, parse, type Sql } from "./db";

export type RecordType =
  "person" | "place" | "organization" | "event" | "task" | "goal" | "note" | "preference" | "commitment" | "document";

export interface RecordSource {
  /** The log row this was learned from, when there is one. */
  log_id?: string;
  run_id?: string;
  /** Where it came from in plain words: "setup", "chat", "calendar". */
  via: string;
}

export interface AtlasRecord {
  id: string;
  type: RecordType;
  name: string;
  fields: Record<string, Json>;
  source: RecordSource;
  learned_at: number;
  updated_at: number;
  confidence: number;
  areas: string[];
  visibility: string;
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
  };
}

export function getRecord(sql: Sql, id: string): AtlasRecord | null {
  const r = sql.exec<RawRecord>(`SELECT * FROM records WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function findRecords(sql: Sql, type: RecordType, name?: string): AtlasRecord[] {
  const rows = name
    ? sql.exec<RawRecord>(`SELECT * FROM records WHERE type = ? AND name = ? ORDER BY updated_at DESC`, type, name)
    : sql.exec<RawRecord>(`SELECT * FROM records WHERE type = ? ORDER BY updated_at DESC`, type);
  return rows.toArray().map(fromRaw);
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
  append(sql, {
    actor: "atlas",
    kind: "record.change",
    run_id: rec.source.run_id ?? null,
    body: { record_id: id, type: rec.type, name: rec.name, change: "created", after: created.fields },
  });
  return created;
}

/**
 * A correction replaces the current values, and the old values stay in
 * history (§5.1). Fields set to null are removed.
 */
export function correctRecord(sql: Sql, id: string, patch: Record<string, Json>, reason: string, source: RecordSource): AtlasRecord {
  const before = getRecord(sql, id);
  if (!before) throw new Error(`no record ${id}`);
  const fields: Record<string, Json> = { ...before.fields };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete fields[k];
    else fields[k] = v;
  }
  const now = Date.now();
  sql.exec(
    `INSERT INTO record_history (record_id, at, fields, reason) VALUES (?, ?, ?, ?)`,
    id,
    now,
    JSON.stringify(before.fields),
    reason,
  );
  sql.exec(
    `UPDATE records SET fields = ?, source = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(fields),
    JSON.stringify(source),
    now,
    id,
  );
  append(sql, {
    actor: source.via === "owner" ? "owner" : "atlas",
    kind: "record.change",
    run_id: source.run_id ?? null,
    body: { record_id: id, type: before.type, name: before.name, change: "corrected", before: before.fields, after: fields, reason },
  });
  return getRecord(sql, id)!;
}

export function recordHistory(sql: Sql, id: string): Array<{ at: number; fields: Record<string, Json>; reason: string }> {
  return sql
    .exec<{ at: number; fields: string; reason: string }>(
      `SELECT at, fields, reason FROM record_history WHERE record_id = ? ORDER BY seq`,
      id,
    )
    .toArray()
    .map((r) => ({ at: r.at, fields: parse(r.fields, {}), reason: r.reason }));
}

/** The owner's own person record, created on first use. */
export function ownerRecord(sql: Sql): AtlasRecord {
  const existing = sql
    .exec<RawRecord>(`SELECT * FROM records WHERE type = 'person' AND json_extract(fields, '$.is_owner') = 1 LIMIT 1`)
    .toArray()[0];
  if (existing) return fromRaw(existing);
  return createRecord(sql, { type: "person", name: "Owner", fields: { is_owner: true }, source: { via: "setup" } });
}
