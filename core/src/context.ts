// What every run sees (§5.2): a stable block that can be cached (the
// character, standing facts about the owner, and the summary of the
// conversation so far), then a small fresh block (now, open reminders, the
// surface), then every message since that summary. Compaction (§4.1) keeps
// that last part in bounds; recall finds the rest, on demand.

import { codingLines } from "./agent/coding";
import { goalLines } from "./agent/goals";
import { lookedAt } from "./agent/helpers";
import { type McpServer, serversLine } from "./mcp";
import { listPages } from "./pages";
import { listFiles } from "./files";
import { listSkills } from "./skills";
import { focusNow } from "./outbox";
import type { Message } from "./brains/types";
import { character, TEXT_PROFILE, VOICE_PROFILE } from "./character";
import { getItem, upcoming } from "./store/agenda";
import { actionsOf, needsHold, waitingApprovals } from "./approvals";
import { webhooks } from "./webhooks";
import { vault } from "./vault";
import { type Area, getArea, getScope, listAreas } from "./store/areas";
import { parse, type Sql } from "./store/db";
import { type AtlasRecord, standingFacts } from "./store/records";
import { get as getRow, type LogRow, type Surface } from "./store/log";
import type { Settings } from "./store/settings";
import { isoLocal, longLocal, shortLocal } from "./time";
import { situationLines } from "./situation";
import { openTasks, taskView } from "./tasks";
import { loopsLine } from "./loops";
import { pileLine, speakingLine } from "./agent/senses";
import { nodesLine } from "./nodes";

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
  /** Connected MCP servers, for runs that can use them (§9.2). */
  mcp?: McpServer[];
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

  // Jobs, held notifications and approvals share the agenda; they don't push reminders and promises out of the prompt.
  const reminders = upcoming(sql, 100)
    .filter((i) => (i.kind === "reminder" || i.kind === "promise") && i.state === "scheduled")
    .slice(0, 20)
    .map((i) => `- ${isoLocal(new Date(i.due_at), tz)}: ${i.kind === "promise" ? "your promise: " : ""}${i.title} (id ${i.id})`);
  const fresh = [
    `Now: ${longLocal(now, tz)} (${isoLocal(now, tz)}), time zone ${tz}.`,
    situationLines(sql, settings, now.getTime()),
    nodesLine(sql),
    focusLine(sql, tz),
    pagesLine(sql),
    skillsLine(sql),
    brainsLine(settings),
    serversLine(opts.mcp ?? []),
    reminders.length ? `Upcoming reminders and promises:\n${reminders.join("\n")}` : "No upcoming reminders or promises.",
    tasksLine(sql, tz),
    loopsLine(sql, tz),
    speakingLine(settings),
    // What could wait, for the owner's own turns; Atlas's own runs get it in their notes.
    surface === "none" ? "" : pileLine(sql, settings),
    areaContext(sql, opts.beforeSeq),
    exitsContext(sql, tz, now),
    jobsLine(sql, now),
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

/**
 * What a run is told about its ways out (§12): the owner's webhooks, what's
 * waiting for their OK, and what was settled in the last two hours, so
 * Atlas never says something is done that's still waiting, or the reverse.
 */
/**
 * The named brains (§18), by name and what each is good for, never a vendor
 * or a model: delegate's `brain` takes one, when the work suits it.
 */
function brainsLine(settings: Settings): string {
  const named = settings.named_brains.brains;
  if (!named.length) return "";
  return `Brains you can hand work to (delegate's brain, by name; leave it out for the usual one):\n${named
    .map((b) => `- ${b.name}${b.line ? `: ${b.line}` : ""}`)
    .join("\n")}`;
}

/** The skills index (§9.3): every active skill's one line, most used first, so Atlas finds them again. */
function skillsLine(sql: Sql): string {
  const skills = listSkills(sql).slice(0, 60);
  return skills.length
    ? `Your skills (open one with skill_read before a task it covers; when it was wrong, patch it with skill_save):\n${skills
        .map((s) => `- ${s.name}: ${s.description}${s.checked && !s.checked.ok ? " (its last check failed)" : ""}`)
        .join("\n")}`
    : "";
}

/** Open tasks (§5.1): what the owner has to do, with when each fits; Atlas brings one up when it fits. */
function tasksLine(sql: Sql, tz: string): string {
  const open = openTasks(sql).slice(0, 25);
  if (!open.length) return "";
  return `To do (open tasks; bring one up when it fits, task_done when it's done or not needed):\n${open
    .map((r) => {
      const v = taskView(r);
      return `- ${v.title}${v.fits ? ` (${v.fits})` : ""}${v.by ? `, by ${shortLocal(new Date(v.by), tz)}` : ""} (id ${v.id})`;
    })
    .join("\n")}`;
}

function pagesLine(sql: Sql): string {
  const pages = listPages(sql).slice(0, 20);
  const files = listFiles(sql).slice(0, 20);
  return [
    pages.length ? `The owner's pages (newest first; page_read to read one): ${pages.map((p) => `${p.name} (${p.id})`).join(", ")}.` : "",
    files.length ? `Files you've made (newest first; file_read reads a text one): ${files.map((f) => f.name).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function focusLine(sql: Sql, tz: string): string {
  const f = focusNow(sql);
  return f
    ? `The owner is focusing${f.about ? ` on ${f.about}` : ""} until ${shortLocal(new Date(f.until), tz)}: notifications that can wait are held.`
    : "";
}

function exitsContext(sql: Sql, tz: string, now: Date): string {
  const lines: string[] = [];
  const hooks = webhooks(sql);
  if (hooks.length) {
    lines.push(
      `The owner's webhooks (call them with webhook_call):\n${hooks.map((w) => `- ${w.name}${w.about ? `: ${w.about}` : ""}`).join("\n")}`,
    );
  }
  const entries = vault(sql);
  if (entries.length) {
    lines.push(
      `The owner's vault (fill an entry into the browser with vault_fill; you never see the values):\n${entries
        .map(
          (e) =>
            `- ${e.name} (${e.kind}, fills on ${e.sites.join(", ")}): ${[...Object.keys(e.values), ...(e.totp ? ["code"] : [])].join(", ")}`,
        )
        .join("\n")}`,
    );
  }
  const waiting = waitingApprovals(sql);
  if (waiting.length) {
    lines.push(
      `Waiting for the owner's OK:\n${waiting
        .map(
          (a) =>
            `- ${a.title} (id ${a.id}, until ${shortLocal(new Date(a.due_at), tz)}${needsHold(actionsOf(a)) ? ", needs a hold in the app" : ""})`,
        )
        .join("\n")}`,
    );
  }
  const settled = sql
    .exec<{ body: string; at: number }>(
      `SELECT body, at FROM log WHERE kind = 'agenda.change' AND json_extract(body, '$.kind') = 'approval' AND json_extract(body, '$.change') IN ('done', 'cancelled', 'failed') AND at > ? ORDER BY seq DESC LIMIT 5`,
      now.getTime() - 2 * 3600_000,
    )
    .toArray()
    .map((r) => {
      const b = parse<{ title?: string; change?: string; results?: string[]; item_id?: string }>(r.body, {});
      const what =
        b.change === "done"
          ? `approved: ${(b.results ?? []).join(" ")}`
          : b.change === "cancelled"
            ? "declined, not done"
            : "ran out, not done";
      return `- ${b.title ?? getItem(sql, b.item_id ?? "")?.title ?? "An approval"}, ${what} (${shortLocal(new Date(r.at), tz)})`;
    });
  if (settled.length) lines.push(`Approvals settled lately:\n${settled.join("\n")}`);
  return lines.join("\n\n");
}

/** Helpers working now (§8.1), so "how's it going?" has an answer while they work. */
function jobsLine(sql: Sql, now: Date): string {
  const running = sql
    .exec<{ id: string; title: string; created_at: number; source: string }>(
      `SELECT id, title, created_at, source FROM agenda WHERE kind = 'job' AND json_extract(source, '$.detail.coding') IS NULL AND json_extract(source, '$.detail.goal') IS NULL AND json_extract(source, '$.detail.step_of') IS NULL AND state IN ('scheduled', 'running') ORDER BY created_at LIMIT 10`,
    )
    .toArray();
  const coding = codingLines(sql, now);
  const codingText = coding.length
    ? `Coding jobs (answer "how's the job?" from these; jobs_look has more, job_answer passes the owner's words on):\n${coding.join("\n")}`
    : "";
  const owned = goalLines(sql);
  const ownedText = owned.length
    ? `Jobs you own (answer "how's the job?" from these; jobs_look has more, job_answer passes the owner's words on):\n${owned.join("\n")}`
    : "";
  if (!running.length) return [codingText, ownedText].filter(Boolean).join("\n\n");
  const lines = running.map((j) => {
    const detail = parse<{ detail?: { helper_run?: string; research?: boolean } }>(j.source, {}).detail;
    const run = detail?.helper_run;
    const steps = run ? sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE run_id = ? AND kind = 'tool.call'`, run).one().n : 0;
    const mins = Math.max(0, Math.round((now.getTime() - j.created_at) / 60_000));
    const read = detail?.research && run ? lookedAt(sql, run) : null;
    return `- ${j.title} (id ${j.id}${detail?.research ? ", a long research job" : ""}): started ${mins ? `${mins} min` : "under a minute"} ago, ${steps} lookup${steps === 1 ? "" : "s"} so far${read ? ` (${read.toLowerCase()})` : ""}`;
  });
  return [
    `Helpers working now (you get each one's result when it's done, and finish the task then):\n${lines.join("\n")}`,
    codingText,
    ownedText,
  ]
    .filter(Boolean)
    .join("\n\n");
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
