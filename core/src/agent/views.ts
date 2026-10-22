// What the app's places read (§21.2): Library's records, History's log,
// Inbox's waiting items. Each is a read of the one log or the records, shaped
// for its page; nothing here changes anything except marking Inbox items done.

import type { HistoryFilter, HistoryStats, InboxItem, RecordView } from "../protocol";
import { parse, type Sql } from "../store/db";
import { get as getRow, type LogKind, type LogRow } from "../store/log";
import { type AtlasRecord, getRecord, RECORD_TYPES, type RecordType, recordHistory } from "../store/records";
import { getState, setState } from "../store/state";

// --- Library -----------------------------------------------------------------------------

export function recordView(sql: Sql, r: AtlasRecord): RecordView {
  const { fact, is_owner: _o, ...details } = r.fields;
  const from = r.source.log_id ? getRow(sql, r.source.log_id) : null;
  const history = recordHistory(sql, r.id);
  const last = history[history.length - 1];
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    fact: typeof fact === "string" ? fact : "",
    details: details as Record<string, unknown>,
    areas: r.areas,
    learned_at: r.learned_at,
    updated_at: r.updated_at,
    confidence: r.confidence,
    source: from
      ? { via: r.source.via, text: String(from.body.text ?? "").slice(0, 200), at: from.at, surface: from.surface }
      : { via: r.source.via },
    corrections: history.length,
    was: last ? { name: last.name ?? r.name, fact: typeof last.fields.fact === "string" ? last.fields.fact : "", at: last.at } : null,
  };
}

/** A row is tagged with an area: its `areas` JSON array holds the id. */
export const TAGGED = `EXISTS (SELECT 1 FROM json_each(areas) WHERE value = ?)`;

export function listRecords(
  sql: Sql,
  q: { type?: RecordType | "all"; area?: string | null; text?: string; limit?: number },
): { records: RecordView[]; counts: Record<string, number> } {
  const where = [`state = 'active'`, `NOT (type = 'person' AND coalesce(json_extract(fields, '$.is_owner'), 0) = 1)`];
  const args: unknown[] = [];
  if (q.type && q.type !== "all") {
    where.push(`type = ?`);
    args.push(q.type);
  }
  if (q.area) {
    where.push(`${TAGGED}`);
    args.push(q.area);
  }
  if (q.text?.trim()) {
    where.push(`(instr(lower(name), lower(?)) > 0 OR instr(lower(fields), lower(?)) > 0)`);
    args.push(q.text.trim(), q.text.trim());
  }
  const rows = sql
    .exec<{ id: string }>(`SELECT id FROM records WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`, ...args, q.limit ?? 100)
    .toArray();
  const counts: Record<string, number> = { all: 0 };
  for (const t of RECORD_TYPES) counts[t] = 0;
  const areaWhere = q.area ? ` AND ${TAGGED}` : "";
  for (const c of sql
    .exec<{ type: string; n: number }>(
      `SELECT type, count(*) AS n FROM records WHERE state = 'active' AND NOT (type = 'person' AND coalesce(json_extract(fields, '$.is_owner'), 0) = 1)${areaWhere} GROUP BY type`,
      ...(q.area ? [q.area] : []),
    )
    .toArray()) {
    counts[c.type] = c.n;
    counts.all! += c.n;
  }
  return { records: rows.map((r) => recordView(sql, getRecord(sql, r.id)!)), counts };
}

// --- History -----------------------------------------------------------------------------

const KINDS: Record<HistoryFilter, LogKind[]> = {
  everything: [
    "message.in",
    "tool.result",
    "record.change",
    "agenda.change",
    "area.change",
    "job.result",
    "run.end",
    "brain.fallback",
    "context.summary",
    "settings.change",
  ],
  actions: ["tool.result", "record.change", "agenda.change", "area.change"],
  conversations: ["message.in", "message.out"],
  jobs: ["job.result", "agenda.change"],
};

/** Whether a row belongs on History's list for a filter: the things that happened, not the plumbing. */
function shown(row: LogRow, filter: HistoryFilter): boolean {
  if (row.kind === "tool.result") return row.body.receipt != null;
  if (row.kind === "run.end") return row.body.state === "failed";
  if (filter === "jobs" && row.kind === "agenda.change") return row.body.kind === "job";
  return true;
}

export function history(
  sql: Sql,
  q: { filter: HistoryFilter; before_seq?: number; area?: string | null; limit?: number },
): { rows: LogRow[]; has_more: boolean } {
  const kinds = KINDS[q.filter];
  const limit = q.limit ?? 60;
  const out: LogRow[] = [];
  let before = q.before_seq ?? Number.MAX_SAFE_INTEGER;
  let more = true;
  for (let page = 0; page < 10 && out.length < limit && more; page++) {
    const ids = sql
      .exec<{ id: string; seq: number }>(
        `SELECT id, seq FROM log WHERE kind IN (${kinds.map(() => "?").join(", ")}) AND seq < ?${q.area ? ` AND ${TAGGED}` : ""} ORDER BY seq DESC LIMIT ?`,
        ...kinds,
        before,
        ...(q.area ? [q.area] : []),
        limit * 2,
      )
      .toArray();
    more = ids.length === limit * 2;
    for (const { id, seq } of ids) {
      before = seq;
      const row = getRow(sql, id)!;
      if (shown(row, q.filter)) out.push(row);
      if (out.length >= limit) break;
    }
  }
  return { rows: out, has_more: more || out.length >= limit };
}

/** Today's totals for History's strip, counted from local midnight. */
export function historyStats(sql: Sql, dayStart: number): HistoryStats {
  const count = (where: string, ...args: unknown[]) =>
    sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE at >= ? AND ${where}`, dayStart, ...args).one().n;
  const per_hour = new Array<number>(24).fill(0);
  for (const r of sql
    .exec<{ h: number; n: number }>(
      `SELECT CAST((at - ?) / 3600000 AS INTEGER) AS h, count(*) AS n FROM log WHERE at >= ? AND kind IN ('message.in', 'tool.result', 'record.change', 'agenda.change') GROUP BY h`,
      dayStart,
      dayStart,
    )
    .toArray()) {
    if (r.h >= 0 && r.h < 24) per_hour[r.h] = r.n;
  }
  return {
    actions:
      count(`kind = 'tool.result' AND json_extract(body, '$.receipt') IS NOT NULL`) +
      count(`kind IN ('record.change', 'agenda.change') AND actor != 'system'`),
    conversations: count(`kind = 'message.in'`),
    jobs: count(`kind = 'job.result'`),
    tokens:
      sql
        .exec<{ n: number | null }>(
          `SELECT sum(coalesce(json_extract(body, '$.usage.input'), 0) + coalesce(json_extract(body, '$.usage.output'), 0)) AS n FROM log WHERE at >= ? AND kind = 'message.out'`,
          dayStart,
        )
        .one().n ?? 0,
    per_hour,
  };
}

/** Everything one run did, for a History row opened into its receipt. */
export function runDetail(sql: Sql, runId: string): { run: Record<string, unknown> | null; rows: LogRow[] } {
  const run = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM runs WHERE id = ?`, runId).toArray()[0] ?? null;
  const rows = sql
    .exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? ORDER BY seq LIMIT 200`, runId)
    .toArray()
    .map((r) => getRow(sql, r.id)!);
  return { run: run ? { ...run, detail: parse(String(run.detail ?? "{}"), {}) } : null, rows };
}

// --- Inbox -------------------------------------------------------------------------------

/**
 * What's waiting on the owner (§21.2). In M1 that's finished background
 * work to look over and runs that didn't finish; approvals and questions
 * join with the outbox in M2. Marked done by the owner, never by Atlas.
 */
export function inbox(sql: Sql): InboxItem[] {
  const done = JSON.stringify(getState<string[]>(sql, "inbox_done") ?? []);
  const since = Date.now() - 14 * 86_400_000;
  const rows = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE at > ? AND (kind = 'job.result' OR (kind = 'run.end' AND json_extract(body, '$.state') = 'failed' AND json_extract(body, '$.trigger') NOT IN ('compaction', 'areas'))) AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT 100`,
      since,
      done,
    )
    .toArray()
    .map((r) => getRow(sql, r.id)!);
  return rows.map((r): InboxItem => {
    if (r.kind === "job.result") {
      const ok = r.body.state === "done";
      return {
        id: r.id,
        kind: ok ? "review" : "failed",
        title: String(r.body.title ?? "A job"),
        text: String((ok ? r.body.text : r.body.error) ?? "").slice(0, 2_000),
        at: r.at,
        areas: r.areas,
        run_id: r.run_id,
      };
    }
    return {
      id: r.id,
      kind: "failed",
      title: "A reply didn't finish",
      text: String(r.body.error ?? "The run failed."),
      at: r.at,
      areas: r.areas,
      run_id: r.run_id,
    };
  });
}

export function inboxDone(sql: Sql, id: string): void {
  const list = getState<string[]>(sql, "inbox_done") ?? [];
  if (!list.includes(id)) setState(sql, "inbox_done", [...list, id].slice(-500));
}
