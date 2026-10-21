// What every run sees (§5.2): a stable block that can be cached (the
// character and standing facts about the owner), then a small fresh block
// (now, open reminders, the surface), then the recent thread from the log.

import type { Message } from "./brains/types";
import { character, TEXT_PROFILE, VOICE_PROFILE } from "./character";
import { upcoming } from "./store/agenda";
import type { Sql } from "./store/db";
import { type LogRow, recent } from "./store/log";
import type { Settings } from "./store/settings";
import type { Surface } from "./store/log";
import { isoLocal, longLocal } from "./time";

/** How many recent messages a run sees. Compaction and recall arrive in M1. */
export const HISTORY_MESSAGES = 40;

export function systemPrompt(opts: { settings: Settings; tz: string; now: Date; surface: Surface; sql: Sql; extra?: string }): string {
  const { settings, tz, now, surface, sql } = opts;
  const stable = character(settings.assistant_name, settings.owner_name);

  const reminders = upcoming(sql, 15)
    .filter((i) => i.kind === "reminder")
    .map((i) => `- ${isoLocal(new Date(i.due_at), tz)}: ${i.title} (id ${i.id})`);
  const fresh = [
    `Now: ${longLocal(now, tz)} (${isoLocal(now, tz)}), time zone ${tz}.`,
    reminders.length ? `Upcoming reminders:\n${reminders.join("\n")}` : "No upcoming reminders.",
    surface === "voice" ? VOICE_PROFILE : surface === "none" ? "" : TEXT_PROFILE,
    opts.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `${stable}\n\n---\n\n${fresh}`;
}

/**
 * The recent thread as model messages, oldest first. Consecutive messages
 * from the same side are merged, since some chat templates require turns to
 * alternate.
 */
export function history(sql: Sql, excludeRunId?: string, limit = HISTORY_MESSAGES, beforeSeq?: number): Message[] {
  const rows: LogRow[] = recent(sql, ["message.in", "message.out"], limit, beforeSeq).filter(
    (r) => !excludeRunId || r.run_id !== excludeRunId,
  );
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
