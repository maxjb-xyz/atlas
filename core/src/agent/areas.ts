// Keeping areas accurate without micromanaging (§6.3): tagging new messages
// and records with the `decide` role, discovering areas when things keep
// coming up that fit none, and learning from the owner's corrections.

import type { Decider, YesNo } from "../brains/decide";
import { MAX_QUESTIONS } from "../brains/decide";
import { addExample, type Area, createArea, examples, getArea, listAreas, setTags, type Tagged, tagsOf, updateArea } from "../store/areas";
import { parse, type Sql } from "../store/db";
import { append, get as getRow, type LogRow } from "../store/log";
import { getRecord, recordText } from "../store/records";
import { getState, setState } from "../store/state";

/** An item gets an area at this probability or above; below it, no area (§6.3: if unsure, nothing). */
export const TAG_AT = 0.6;
/** A message that fits no area but is about an ongoing part of life, at this probability, counts toward a new one. */
export const UNFILED_AT = 0.7;
/** Discovery runs once this many messages fit no area. */
export const DISCOVER_AFTER = 5;
/** A proposed area needs at least this many messages to be started. */
export const NEW_AREA_MIN = 3;

const ONGOING: YesNo = {
  instructions:
    "Is this about an ongoing part of the owner's life, such as a job, a business, a client, school, family, health, money, home, travel or a hobby, rather than small talk or a one-off question?",
};

function question(sql: Sql, a: Area): YesNo {
  const ex = examples(sql, a.id);
  const yes = ex.filter((e) => e.fits).map((e) => `"${e.text}"`);
  const no = ex.filter((e) => !e.fits).map((e) => `"${e.text}"`);
  return {
    instructions: [
      `Is this about ${a.name}${a.about ? ` (${a.about})` : ""}, one of the areas of the owner's life?`,
      yes.length ? `These belong to ${a.name}: ${yes.join("; ")}.` : "",
      no.length ? `These don't: ${no.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export interface TagPass {
  tagged: number;
  unfiled: number;
  /** Log rows whose tags changed, for the app's chips. */
  changed: string[];
}

/**
 * Tags messages logged since the last pass, and records not tagged yet. An
 * owner's message is asked about; Atlas's reply takes its question's areas.
 */
export async function tagPending(
  sql: Sql,
  decider: Decider,
  opts: { limit?: number; between?: () => Promise<void> } = {},
): Promise<TagPass> {
  const areas = listAreas(sql).slice(0, MAX_QUESTIONS - 1);
  const questions: Record<string, YesNo> = { ongoing: ONGOING };
  for (const a of areas) questions[a.id] = question(sql, a);
  const limit = opts.limit ?? 50;
  let tagged = 0;
  let unfiled = 0;
  const changed: string[] = [];

  const since = getState<number>(sql, "areas_seq") ?? 0;
  const rows = sql
    .exec<{ seq: number; id: string }>(
      `SELECT seq, id FROM log WHERE seq > ? AND kind IN ('message.in', 'message.out') ORDER BY seq LIMIT ?`,
      since,
      limit,
    )
    .toArray();
  for (const r of rows) {
    const row = getRow(sql, r.id)!;
    const text = typeof row.body.text === "string" ? row.body.text : "";
    if (row.kind === "message.out" && row.run_id) {
      // Atlas's answer belongs where the question did.
      const asked = sql
        .exec<{ areas: string }>(`SELECT areas FROM log WHERE run_id = ? AND kind = 'message.in' LIMIT 1`, row.run_id)
        .toArray()[0];
      if (asked) {
        const tags = parse<string[]>(asked.areas, []);
        if (tags.length) {
          setTags(sql, `log:${row.id}`, tags);
          changed.push(row.id);
        }
        setState(sql, "areas_seq", r.seq);
        continue;
      }
    }
    if (text.trim() && row.actor === "owner") {
      const p = await decider.yesNo(text, questions);
      const tags = areas.filter((a) => (p[a.id] ?? 0) >= TAG_AT).map((a) => a.id);
      if (tags.length) {
        setTags(sql, `log:${row.id}`, tags);
        changed.push(row.id);
        for (const a of areas) if (tags.includes(a.id) && a.state === "dormant") updateArea(sql, a.id, { state: "active" }, "atlas");
        tagged += 1;
      } else if ((p.ongoing ?? 0) >= UNFILED_AT) {
        const list = getState<string[]>(sql, "unfiled") ?? [];
        setState(sql, "unfiled", [...list, row.id].slice(-50));
        unfiled += 1;
      }
    }
    setState(sql, "areas_seq", r.seq);
    await opts.between?.();
  }

  if (areas.length) {
    const recs = sql
      .exec<{ id: string }>(`SELECT id FROM records WHERE tagged = 0 AND state = 'active' ORDER BY learned_at LIMIT ?`, limit)
      .toArray();
    for (const { id } of recs) {
      const rec = getRecord(sql, id)!;
      // A record learned from a message that has areas starts with those.
      const from = rec.source.log_id ? tagsOf(sql, `log:${rec.source.log_id}`) : [];
      let tags = from;
      if (!tags.length) {
        const p = await decider.yesNo(recordText(rec), questions);
        tags = areas.filter((a) => (p[a.id] ?? 0) >= TAG_AT).map((a) => a.id);
      }
      setTags(sql, `rec:${id}`, [...rec.areas, ...tags]);
      if (tags.length) tagged += 1;
      await opts.between?.();
    }
  }
  return { tagged, unfiled, changed };
}

/** Messages that fit no area yet but seemed to be about something ongoing. */
export function unfiled(sql: Sql): LogRow[] {
  return (getState<string[]>(sql, "unfiled") ?? []).map((id) => getRow(sql, id)).filter((r): r is LogRow => r != null);
}

export const DISCOVER_NOTE = `[Atlas's upkeep, not the owner] The owner's messages below don't fit any of their areas yet. An area is an ongoing part of someone's life: a job, a business, a client, school, family, health, money, home, a hobby. Group the messages that clearly share one, and name each area the way the owner would ("Keyframes", "Gym", "Mom's move"). Leave out anything that doesn't clearly belong with others. Reply with JSON only, in this shape: {"areas": [{"name": "...", "about": "one short sentence", "messages": [1, 4]}]}. An empty list is fine.`;

/** The prompt for discovery: the existing areas, then the numbered messages. */
export function discoveryPrompt(sql: Sql, rows: LogRow[]): string {
  const existing = listAreas(sql).map((a) => a.name);
  const lines = rows.map((r, i) => `${i + 1}. ${String(r.body.text ?? "").slice(0, 400)}`);
  return `${DISCOVER_NOTE}\n\n${existing.length ? `Areas they already have: ${existing.join(", ")}.\n\n` : ""}Messages:\n${lines.join("\n")}`;
}

/**
 * Starts the areas the brain proposed that cover enough messages, tags
 * those messages, and says so once in the thread (§6.3). Returns the rows
 * that announce new areas. Proposals that don't parse are logged, not used.
 */
export function startDiscovered(sql: Sql, rows: LogRow[], answer: string, runId: string): LogRow[] {
  const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
  const proposal = parse<{ areas?: Array<{ name?: unknown; about?: unknown; messages?: unknown }> }>(json, {});
  const announced: LogRow[] = [];
  const used = new Set<string>();
  for (const p of proposal.areas ?? []) {
    if (typeof p.name !== "string" || !p.name.trim() || !Array.isArray(p.messages)) continue;
    const picked = p.messages.map((n) => (typeof n === "number" ? rows[n - 1] : undefined)).filter((r): r is LogRow => r != null);
    if (picked.length < NEW_AREA_MIN) continue;
    const area = createArea(sql, {
      name: p.name,
      about: typeof p.about === "string" ? p.about : "",
      by: "atlas",
      run_id: runId,
      reason: `${picked.length} conversations about it`,
    });
    for (const r of picked) {
      setTags(sql, `log:${r.id}`, [...r.areas, area.id]);
      addExample(sql, area.id, String(r.body.text ?? ""), true);
      used.add(r.id);
    }
    announced.push(
      append(sql, {
        actor: "atlas",
        kind: "area.change",
        run_id: runId,
        body: { area_id: area.id, name: area.name, change: "started", from: picked.length, about: area.about },
      }),
    );
  }
  const left = (getState<string[]>(sql, "unfiled") ?? []).filter((id) => !used.has(id));
  setState(sql, "unfiled", left);
  return announced;
}

/**
 * The owner moved an item's areas (§6.3). The item and what came from it
 * follow, and the item becomes an example for tagging from then on.
 */
export function correctAreas(sql: Sql, ref: Tagged, areaIds: string[]): LogRow {
  const valid = areaIds.filter((id) => getArea(sql, id));
  const before = tagsOf(sql, ref);
  const added = valid.filter((a) => !before.includes(a));
  const removed = before.filter((a) => !valid.includes(a));
  const text = textOf(sql, ref);
  const move = (r: Tagged) => setTags(sql, r, [...tagsOf(sql, r).filter((a) => !removed.includes(a)), ...added]);

  setTags(sql, ref, valid);
  const related: Tagged[] = [];
  if (ref.startsWith("log:")) {
    const row = getRow(sql, ref.slice(4));
    if (row?.run_id) {
      for (const r of sql
        .exec<{ id: string }>(
          `SELECT id FROM log WHERE run_id = ? AND kind IN ('message.in', 'message.out') AND id != ?`,
          row.run_id,
          row.id,
        )
        .toArray())
        related.push(`log:${r.id}`);
    }
    for (const r of sql
      .exec<{ id: string }>(
        `SELECT id FROM records WHERE json_extract(source, '$.log_id') = ? OR EXISTS (SELECT 1 FROM json_each(records.source, '$.also') WHERE value = ?)`,
        ref.slice(4),
        ref.slice(4),
      )
      .toArray())
      related.push(`rec:${r.id}`);
  } else {
    const links = sql
      .exec<{ id: string }>(
        `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS id FROM links WHERE from_id = ? OR to_id = ?`,
        ref.slice(4),
        ref.slice(4),
        ref.slice(4),
      )
      .toArray();
    for (const l of links) related.push(`rec:${l.id}`);
  }
  for (const r of related) move(r);
  if (text) {
    for (const a of added) addExample(sql, a, text, true);
    for (const a of removed) addExample(sql, a, text, false);
  }
  return append(sql, {
    actor: "owner",
    kind: "area.change",
    body: { change: "moved", ref, before, after: valid, related: related.length },
  });
}

function textOf(sql: Sql, ref: Tagged): string {
  if (ref.startsWith("log:")) {
    const t = getRow(sql, ref.slice(4))?.body.text;
    return typeof t === "string" ? t : "";
  }
  const r = getRecord(sql, ref.slice(4));
  return r ? recordText(r) : "";
}
