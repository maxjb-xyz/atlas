// The agenda's tools (§4.3). Two kinds of item Atlas makes on the owner's
// clock: a reminder, where Atlas says the words the owner asked for at a
// time, and a promise, where Atlas said it would do something later (check,
// follow up, remind only if something hasn't happened) and does it with its
// tools when the time comes. Both are undoable changes to the owner's own
// things, so Atlas makes them, shows a receipt, and offers Undo (§12.1).
// No tool call means no reminder and no promise: the receipt is the proof.

import { z } from "zod";
import type { Json } from "../store/db";
import { get as getRow } from "../store/log";
import { type AgendaItem, createItem, finish, getItem, upcoming } from "../store/agenda";
import { isoLocal, parseWhen, shortLocal } from "../time";
import { defineTool, fail, type ToolContext } from "./types";

/** The kinds of agenda item the owner sees as Atlas's: things it said it would do. */
export const OWNED = ["reminder", "promise"] as const;

/** Where an item was said: the owner's message, so Agenda can link back to it. */
function saidIn(ctx: ToolContext): { log_id?: string; detail: Record<string, Json> } {
  const row = ctx.source_log_id ? getRow(ctx.sql, ctx.source_log_id) : null;
  return row ? { log_id: row.id, detail: { said: String(row.body.text ?? "").slice(0, 300), said_at: row.at } } : { detail: {} };
}

function when(at: string, ctx: ToolContext): Date | string {
  const d = parseWhen(at, ctx.tz);
  if (!d) return `Couldn't read the time "${at}". Use YYYY-MM-DDTHH:mm.`;
  if (d.getTime() < ctx.now.getTime() - 60_000) return `${isoLocal(d, ctx.tz)} is in the past (it's ${isoLocal(ctx.now, ctx.tz)} now).`;
  return d;
}

export const reminderCreate = defineTool({
  name: "reminder_create",
  kind: "change_own",
  status: "Setting that reminder.",
  description: [
    "Set a reminder: at that time Atlas messages the owner with it (in the app, and out loud if they're in a call).",
    "Use it whenever the owner asks to be reminded of something plainly, and whenever you say you'll remind them: no tool call means no reminder.",
    "When the reminder depends on something (only if he hasn't replied, unless it's raining), or needs you to look something up first, use promise instead.",
    "`at` is a local date-time in the owner's time zone, like 2026-10-22T09:00, worked out from what they said and the current time.",
  ].join(" "),
  input: z.object({
    text: z.string().min(1).max(300).describe("What to remind them of, in a few words, as they'd want to read it."),
    at: z.string().describe("When, as a local date-time: YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    const at = when(input.at, ctx);
    if (typeof at === "string") return fail(at);
    const said = saidIn(ctx);
    const item = createItem(ctx.sql, {
      kind: "reminder",
      title: input.text,
      due_at: at.getTime(),
      source: { run_id: ctx.run_id, via: "chat", ...(said.log_id ? { log_id: said.log_id } : {}), detail: said.detail },
    });
    await ctx.clock.schedule(item);
    return {
      ok: true,
      output: { id: item.id, text: item.title, at: isoLocal(at, ctx.tz) },
      receipt: { text: `Reminder · ${shortLocal(at, ctx.tz)} · ${item.title}`, undo: { kind: "reminder.cancel", id: item.id } },
    };
  },
});

export const promise = defineTool({
  name: "promise",
  kind: "change_own",
  status: "Making a note to do that.",
  description: [
    "Make a promise: something you'll do later, at a set time, with your tools and judgment.",
    "Use it in the same step whenever you say you'll do something later: check on something, follow up, look again, get back to the owner, or remind them only if something hasn't happened. No tool call means no promise, so never say 'I'll check' without it.",
    "`what` is the promise in a few words as the owner sees it in Agenda ('Check whether the landlord replied').",
    "`then` is your complete note to yourself for that moment: what to look at (recall, the calendar), what decides it, and what to tell the owner either way. You'll see nothing else of this conversation then.",
    "`at` is a local date-time in the owner's time zone. For a plain reminder with nothing to check, use reminder_create.",
  ].join(" "),
  input: z.object({
    what: z.string().min(1).max(200).describe("The promise in a few words, as the owner reads it in Agenda."),
    then: z
      .string()
      .min(1)
      .max(2_000)
      .describe(
        "Your note to yourself for when it's due: what to check and how, what decides it, and what to tell the owner. E.g. 'Recall whether the owner said the landlord replied since Oct 22. If not, remind them to call him. If so, say there's no need.'",
      ),
    at: z.string().describe("When, as a local date-time: YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    const at = when(input.at, ctx);
    if (typeof at === "string") return fail(at);
    const said = saidIn(ctx);
    const item = createItem(ctx.sql, {
      kind: "promise",
      title: input.what,
      due_at: at.getTime(),
      source: {
        run_id: ctx.run_id,
        via: ctx.via,
        ...(said.log_id ? { log_id: said.log_id } : {}),
        detail: { ...said.detail, then: input.then },
      },
    });
    await ctx.clock.schedule(item);
    return {
      ok: true,
      output: { id: item.id, promised: item.title, at: isoLocal(at, ctx.tz) },
      receipt: { text: `Promised · ${shortLocal(at, ctx.tz)} · ${item.title}`, undo: { kind: "reminder.cancel", id: item.id } },
    };
  },
});

const listed = (i: AgendaItem, tz: string) => ({ id: i.id, kind: i.kind, text: i.title, at: isoLocal(new Date(i.due_at), tz) });

export const agendaList = defineTool({
  name: "agenda_list",
  kind: "look",
  status: "Checking your agenda.",
  description: "List the owner's upcoming reminders and your promises, soonest first, with their ids.",
  input: z.object({}),
  async run(_input, ctx) {
    const items = upcoming(ctx.sql, 100).filter((i) => (OWNED as readonly string[]).includes(i.kind) && i.state === "scheduled");
    return { ok: true, output: { items: items.map((i) => listed(i, ctx.tz)) } };
  },
});

export const agendaCancel = defineTool({
  name: "agenda_cancel",
  kind: "change_own",
  status: "Taking that off.",
  description:
    "Cancel an upcoming reminder or promise by its id (from agenda_list, or your context), when the owner says never mind, or it's no longer needed.",
  input: z.object({ id: z.string().describe("The reminder's or promise's id.") }),
  async run(input, ctx) {
    const item = getItem(ctx.sql, input.id);
    if (!item || !(OWNED as readonly string[]).includes(item.kind)) return fail(`There's no reminder or promise with id ${input.id}.`);
    if (item.state !== "scheduled") return fail(`That ${item.kind} is already ${item.state === "running" ? "happening" : item.state}.`);
    await ctx.clock.unschedule(item);
    finish(ctx.sql, item.id, "cancelled", ctx.run_id, { by: "atlas" });
    return {
      ok: true,
      output: { cancelled: item.id },
      receipt: { text: `Cancelled ${item.kind} · ${item.title}` },
    };
  },
});

export const agendaTools = [reminderCreate, promise, agendaList, agendaCancel];
