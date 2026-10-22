// Focus (§14): for a while, things that can wait are held, the way quiet
// hours hold them, and arrive together when it ends. Reminders the owner set
// and answers to what they asked still come at once. The owner sets it in
// Settings → Notifications, or asks Atlas ("focus for 45 minutes"), and an
// automation's Atlas step can set it too.

import { z } from "zod";
import { type Focus, focusNow } from "../outbox";
import { getItem, rearm } from "../store/agenda";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { readSettings } from "../store/settings";
import { setState } from "../store/state";
import { quietUntil, shortLocal, zoneOf } from "../time";
import { defineTool, type ToolContext } from "./types";

/**
 * Starts focus for `minutes`, or ends it with 0. Ending it early lets what it
 * held go out now, unless quiet hours would hold it anyway.
 */
export async function setFocus(
  sql: Sql,
  clock: ToolContext["clock"],
  minutes: number,
  about: string,
  by: "owner" | "atlas",
): Promise<Focus | null> {
  const was = focusNow(sql);
  if (minutes <= 0) {
    setState(sql, "focus", null);
    append(sql, { actor: by, kind: "settings.change", body: { focus: "ended" } });
    const settings = readSettings(sql);
    if (was && !quietUntil(new Date(), zoneOf(settings), settings.notifications.quiet)) {
      const held = sql
        .exec<{ id: string }>(
          `SELECT id FROM agenda WHERE kind = 'notify' AND state = 'scheduled' AND due_at > ? AND due_at <= ?`,
          Date.now(),
          was.until,
        )
        .toArray();
      for (const { id } of held) {
        const item = getItem(sql, id);
        if (item?.schedule_id) await clock.unschedule(item);
        const now = rearm(sql, id, Date.now());
        if (now) await clock.schedule(now);
      }
    }
    return null;
  }
  const focus: Focus = { until: Date.now() + minutes * 60_000, about: about.trim().slice(0, 80) };
  setState(sql, "focus", focus);
  append(sql, {
    actor: by,
    kind: "settings.change",
    body: { focus: "on", until: focus.until, ...(focus.about ? { about: focus.about } : {}) },
  });
  return focus;
}

export const focusTool = defineTool({
  name: "focus",
  kind: "change_own",
  description: [
    "Start focus for a number of minutes, or end it with 0, when the owner asks ('focus for 45 minutes', 'I'm in a meeting till 3', 'I'm done focusing').",
    "While focus is on, notifications that can wait are held and arrive together when it ends; reminders the owner set and answers to them still come through.",
    "`about` is what they're focusing on, in a few words, if they said.",
  ].join(" "),
  input: z.object({
    minutes: z.number().int().min(0).max(720).describe("How long, in minutes; 0 ends focus now."),
    about: z.string().max(80).optional(),
  }),
  async run(input, ctx) {
    const f = await setFocus(ctx.sql, ctx.clock, input.minutes, input.about ?? "", "atlas");
    const until = f ? shortLocal(new Date(f.until), ctx.tz) : null;
    return {
      ok: true,
      output: f ? { focus: "on", until, about: f.about || null } : { focus: "off" },
      receipt: { text: f ? `Focus · until ${until}${f.about ? ` · ${f.about}` : ""}` : "Focus ended" },
    };
  },
});
