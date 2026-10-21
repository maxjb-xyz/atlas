// Reminders are agenda items (§4.3). Making one is an undoable change to the
// owner's own things, so Atlas does it, says so with a receipt, and offers
// undo (§12.1).

import { z } from "zod";
import { createItem, finish, getItem, upcoming } from "../store/agenda";
import { isoLocal, parseWhen, shortLocal } from "../time";
import { defineTool, fail } from "./types";

export const reminderCreate = defineTool({
  name: "reminder_create",
  kind: "change_own",
  description: [
    "Set a reminder: at that time Atlas messages the owner (in the app, and out loud if they're in a call).",
    "Use it whenever the owner asks to be reminded, and whenever you say you'll remind them: no tool call means no reminder.",
    "`at` is a local date-time in the owner's time zone, like 2026-10-22T09:00, worked out from what they said and the current time.",
  ].join(" "),
  input: z.object({
    text: z.string().min(1).max(300).describe("What to remind them of, in a few words, as they'd want to read it."),
    at: z.string().describe("When, as a local date-time: YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    const at = parseWhen(input.at, ctx.tz);
    if (!at) return fail(`Couldn't read the time "${input.at}". Use YYYY-MM-DDTHH:mm.`);
    if (at.getTime() < ctx.now.getTime() - 60_000) {
      return fail(`${isoLocal(at, ctx.tz)} is in the past (it's ${isoLocal(ctx.now, ctx.tz)} now).`);
    }
    const item = createItem(ctx.sql, {
      kind: "reminder",
      title: input.text,
      due_at: at.getTime(),
      source: { run_id: ctx.run_id, via: "chat" },
    });
    await ctx.clock.schedule(item);
    return {
      ok: true,
      output: { id: item.id, text: item.title, at: isoLocal(at, ctx.tz) },
      receipt: { text: `Reminder · ${shortLocal(at, ctx.tz)} · ${item.title}`, undo: { kind: "reminder.cancel", id: item.id } },
    };
  },
});

export const reminderList = defineTool({
  name: "reminder_list",
  kind: "look",
  status: "Checking your reminders.",
  description: "List the owner's upcoming reminders, soonest first, with their ids.",
  input: z.object({}),
  async run(_input, ctx) {
    const items = upcoming(ctx.sql).filter((i) => i.kind === "reminder");
    return {
      ok: true,
      output: { reminders: items.map((i) => ({ id: i.id, text: i.title, at: isoLocal(new Date(i.due_at), ctx.tz) })) },
    };
  },
});

export const reminderCancel = defineTool({
  name: "reminder_cancel",
  kind: "change_own",
  description: "Cancel an upcoming reminder by its id (from reminder_list or reminder_create).",
  input: z.object({ id: z.string().describe("The reminder's id.") }),
  async run(input, ctx) {
    const item = getItem(ctx.sql, input.id);
    if (!item || item.kind !== "reminder") return fail(`There's no reminder with id ${input.id}.`);
    if (item.state !== "scheduled") return fail(`That reminder is already ${item.state}.`);
    await ctx.clock.unschedule(item);
    finish(ctx.sql, item.id, "cancelled", ctx.run_id, { by: "atlas" });
    return {
      ok: true,
      output: { cancelled: item.id },
      receipt: { text: `Cancelled reminder · ${item.title}` },
    };
  },
});

export const reminderTools = [reminderCreate, reminderList, reminderCancel];
