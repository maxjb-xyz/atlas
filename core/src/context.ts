// What every run sees (§5.2): a stable block that can be cached (the
// character, standing facts about the owner, and the summary of the
// conversation so far), then a small fresh block (now, open reminders, the
// surface), then every message since that summary. Compaction (§4.1) keeps
// that last part in bounds; recall finds the rest, on demand.

import type { Message } from "./brains/types";
import { character, TEXT_PROFILE, VOICE_PROFILE } from "./character";
import { upcoming } from "./store/agenda";
import { type Area, getArea, getScope, listAreas } from "./store/areas";
import { parse, type Sql } from "./store/db";
import { type AtlasRecord, standingFacts } from "./store/records";
import { get as getRow, type LogRow, type Surface } from "./store/log";
import type { Settings } from "./store/settings";
import { isoLocal, longLocal, shortLocal } from "./time";

/**
 * The context window Atlas plans for, in tokens. Providers don't say what
 * their windows are, so this is a size every brain Atlas offers can take.
 */
export const CONTEXT_TOKENS = 128_000;

/** A rough token count: about four characters each, which is close enough to plan by. */
export const tokens = (text: string) => Math.ceil(text.length / 4);

/** The most messages a run reads back from the log, however short they are. */
export const MAX_HISTORY_ROWS = 400;

export interface Summary {
  seq: number;
  at: number;
  text: string;
  /** The last message the summary covers. */
  through_seq: number;
}

/** The summary in force before a point in the log (by default, the newest). */
export function latestSummary(sql: Sql, beforeSeq?: number): Summary | null {
  const r = sql
    .exec<{ seq: number; at: number; body: string }>(
      `SELECT seq, at, body FROM log WHERE kind = 'context.summary' AND seq < ? ORDER BY seq DESC LIMIT 1`,
      beforeSeq ?? Number.MAX_SAFE_INTEGER,
    )
    .toArray()[0];
  if (!r) return null;
  const body = parse<{ text?: unknown; through_seq?: unknown }>(r.body, {});
  if (typeof body.text !== "string" || typeof body.through_seq !== "number") return null;
  return { seq: r.seq, at: r.at, text: body.text, through_seq: body.through_seq };
}

export function systemPrompt(opts: {
  settings: Settings;
  tz: string;
  now: Date;
  surface: Surface;
  sql: Sql;
  /** Only what was known before this point in the log counts (runs wait in line). */
  beforeSeq?: number;
  extra?: string;
}): string {
  const { settings, tz, now, surface, sql } = opts;
  const summary = latestSummary(sql, opts.beforeSeq);
  const stable = [
    character(settings.assistant_name, settings.owner_name, settings.character),
    facts(sql, settings.owner_name),
    summary
      ? `Earlier in this conversation (your own summary, written ${shortLocal(new Date(summary.at), tz)}; recall has the full messages):\n${summary.text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const reminders = upcoming(sql, 15)
    .filter((i) => i.kind === "reminder")
    .map((i) => `- ${isoLocal(new Date(i.due_at), tz)}: ${i.title} (id ${i.id})`);
  const fresh = [
    `Now: ${longLocal(now, tz)} (${isoLocal(now, tz)}), time zone ${tz}.`,
    reminders.length ? `Upcoming reminders:\n${reminders.join("\n")}` : "No upcoming reminders.",
    areaContext(sql, opts.beforeSeq),
    surface === "voice" ? VOICE_PROFILE : surface === "none" ? "" : TEXT_PROFILE,
    opts.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `${stable}\n\n---\n\n${fresh}`;
}

/**
 * Standing facts about the owner, with ids so Atlas can correct one. Oldest
 * first, so new facts add to the end and the cached start stays the same.
 */
function facts(sql: Sql, ownerName: string): string {
  const lines = standingFacts(sql).map(factLine).filter(Boolean);
  if (!lines.length) return "";
  const owner = ownerName.trim() || "the owner";
  return `What you know about ${owner} for good (use it quietly; pass the id to remember or forget to change one):\n${lines.join("\n")}`;
}

function factLine(r: AtlasRecord): string {
  const { fact, is_owner: _owner, ...details } = r.fields;
  const parts = [typeof fact === "string" ? fact : r.type === "person" ? "" : r.name];
  for (const [k, v] of Object.entries(details)) parts.push(`${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const text = parts.filter(Boolean).join("; ");
  return text ? `- ${text} (id ${r.id})` : "";
}

/** The messages since the summary in force, oldest first, as log rows. */
export function sinceSummary(sql: Sql, beforeSeq?: number): LogRow[] {
  const from = latestSummary(sql, beforeSeq)?.through_seq ?? 0;
  const ids = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE kind IN ('message.in', 'message.out') AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
      from,
      beforeSeq ?? Number.MAX_SAFE_INTEGER,
      MAX_HISTORY_ROWS,
    )
    .toArray();
  return ids.reverse().map((r) => getRow(sql, r.id)!);
}

/**
 * The conversation since the last summary, as model messages. `budget`
 * (tokens) is a safety net for when compaction hasn't caught up: the oldest
 * messages are left out until the rest fit, and recall still has them.
 */
export function history(sql: Sql, opts: { excludeRunId?: string; beforeSeq?: number; budget?: number } = {}): Message[] {
  let rows = sinceSummary(sql, opts.beforeSeq).filter((r) => !opts.excludeRunId || r.run_id !== opts.excludeRunId);
  if (opts.budget != null) {
    let total = rows.reduce((n, r) => n + tokens(String(r.body.text ?? "")), 0);
    let drop = 0;
    while (total > opts.budget && drop < rows.length - 1) total -= tokens(String(rows[drop++]!.body.text ?? ""));
    rows = rows.slice(drop);
  }
  return toMessages(rows);
}

/**
 * Log rows as model messages, oldest first. Consecutive messages from the
 * same side are merged, since some chat templates require turns to alternate.
 */
export function toMessages(rows: LogRow[]): Message[] {
  const out: Message[] = [];
  for (const r of rows) {
    const text = typeof r.body.text === "string" ? r.body.text : "";
    if (!text) continue;
    const role = r.kind === "message.in" ? "user" : "assistant";
    const content = r.surface === "voice" && role === "user" ? `(said aloud) ${text}` : text;
    const last = out[out.length - 1];
    if (last && last.role === role && (role === "user" || role === "assistant")) {
      (last as { content: string }).content += `\n\n${content}`;
    } else {
      out.push(role === "user" ? { role, content } : { role, content });
    }
  }
  // A thread can't open with Atlas's own message for some providers; give it context instead.
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** Appends the new owner message, merging if the thread already ends on one. */
export function withMessage(messages: Message[], content: string): Message[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (last?.role === "user") out[out.length - 1] = { role: "user", content: `${last.content}\n\n${content}` };
  else out.push({ role: "user", content });
  return out;
}

/**
 * The "hat" a run wears (§6.2): the area the owner is focused on, or else
 * the areas of the latest tagged message in the last half hour.
 */
export function hat(sql: Sql, beforeSeq?: number): Area[] {
  const scope = getScope(sql);
  if (scope) return [getArea(sql, scope)!];
  const r = sql
    .exec<{ areas: string }>(
      `SELECT areas FROM log WHERE kind = 'message.in' AND areas != '[]' AND seq < ? AND at > ? ORDER BY seq DESC LIMIT 1`,
      beforeSeq ?? Number.MAX_SAFE_INTEGER,
      Date.now() - 30 * 60_000,
    )
    .toArray()[0];
  return parse<string[]>(r?.areas, [])
    .map((id) => getArea(sql, id))
    .filter((a): a is Area => a != null && a.state !== "archived");
}

/** What a run is told about areas: the hat, its tone, and the owner's other areas. */
function areaContext(sql: Sql, beforeSeq?: number): string {
  const all = listAreas(sql).filter((a) => a.state !== "archived");
  if (!all.length) return "";
  const worn = hat(sql, beforeSeq);
  const lines: string[] = [];
  if (worn.length) {
    for (const a of worn) {
      lines.push(`You're acting in ${a.name}${a.about ? ` (${a.about})` : ""}.${a.settings.tone ? ` Tone here: ${a.settings.tone}.` : ""}`);
    }
  }
  lines.push(`The owner's areas: ${all.map((a) => a.name).join(", ")}. You can talk about any of them at any time.`);
  return lines.join(" ");
}
