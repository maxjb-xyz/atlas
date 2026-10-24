// The task tools (VISION §5.1): keeping a thing to do, with when it fits
// and a deadline, and closing it. Both change the owner's own things, so
// Atlas does them, shows a receipt, and offers Undo (§12.1).

import { z } from "zod";
import { get as getRow } from "../store/log";
import { addTask, closeTask, fitsText } from "../tasks";
import { isoLocal, parseWhen, shortLocal } from "../time";
import { PLACE_KINDS } from "../maps";
import { defineTool, fail } from "./types";

export const taskAdd = defineTool({
  name: "task_add",
  kind: "change_own",
  status: "Adding it to your list.",
  description: [
    "Keep a thing to do for the owner, from any part of life: 'tell Doug about the offsite when I see him', 'ask Sam about the budget next time we talk', 'when the release ships, update the changelog', 'grab the charger at the office', 'I need oat milk', 'try Bern's next time I'm in Tampa'.",
    "Say when it fits, if it does: a kind of place, a place, a person, or plain words. You'll keep it in mind and bring it up when it fits (passing a store, a meeting with Doug coming up, Sam emailing them); with only a deadline, it reminds them once then.",
    "For something at a set time with nothing to do but be reminded, use reminder_create instead. The owner sees a 'To do' chip with Undo, and the task in Agenda.",
  ].join(" "),
  input: z.object({
    what: z.string().min(1).max(200).describe("The thing to do in a few words: 'Oat milk', 'Ask Sam about the budget'."),
    fits: z
      .object({
        kind: z
          .string()
          .max(60)
          .optional()
          .describe(`A kind of place it's done at: ${PLACE_KINDS.join(", ")}, or any other as a word or an OpenStreetMap tag.`),
        place: z
          .string()
          .max(120)
          .optional()
          .describe("A particular place, when it has to be that one: a saved place's name or an address."),
        person: z
          .string()
          .max(80)
          .optional()
          .describe(
            "A person, by the name the owner uses ('Doug'): it fits next time they're in touch, such as an event with them coming up or something from them. Keep what you know of them (an email, other names) on their person record with remember, so an invite with only their address still counts.",
          ),
        words: z
          .string()
          .max(160)
          .optional()
          .describe("Anything else, in plain words: 'next time I'm in Tampa', 'when the new season's out'."),
      })
      .optional(),
    by: z.string().optional().describe("A deadline, if there is one, as a local date-time YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    const deadline = input.by ? parseWhen(input.by, ctx.tz) : null;
    if (input.by && !deadline) return fail(`Couldn't read the deadline "${input.by}". Use YYYY-MM-DDTHH:mm.`);
    const said = ctx.source_log_id ? getRow(ctx.sql, ctx.source_log_id) : null;
    const { task, reminder } = addTask(ctx.sql, {
      title: input.what,
      ...(input.fits ? { fits: input.fits } : {}),
      by: deadline?.getTime() ?? null,
      source: { via: ctx.via, run_id: ctx.run_id, ...(said ? { log_id: said.id } : {}) },
    });
    if (reminder) await ctx.clock.schedule(reminder);
    const fits = fitsText(input.fits ?? {});
    return {
      ok: true,
      output: { id: task.id, task: task.name, ...(fits ? { fits } : {}), ...(deadline ? { by: isoLocal(deadline, ctx.tz) } : {}) },
      receipt: {
        text: `To do · ${task.name}${fits ? ` · ${fits}` : ""}${deadline ? ` · by ${shortLocal(deadline, ctx.tz)}` : ""}`,
        undo: { kind: "record.forget", id: task.id },
      },
    };
  },
});

export const taskDone = defineTool({
  name: "task_done",
  kind: "change_own",
  status: "Ticking it off.",
  description:
    "Close a task: done (the owner did it) or dropped (they don't need it any more), so you stop bringing it up. Its id is in the open tasks in your context.",
  input: z.object({ id: z.string().max(64), why: z.enum(["done", "dropped"]).default("done") }),
  async run(input, ctx) {
    const out = closeTask(ctx.sql, input.id, input.why, { via: ctx.via, run_id: ctx.run_id });
    if (!out) return fail(`There's no open task with id ${input.id}.`);
    for (const r of out.reminders) await ctx.clock.unschedule(r);
    return {
      ok: true,
      output: { [input.why]: out.task.name },
      receipt: {
        text: `${input.why === "done" ? "Done" : "Dropped"} · ${out.task.name}`,
        undo: { kind: "record.revert", id: out.task.id, history: out.history },
      },
    };
  },
});

export const taskTools = [taskAdd, taskDone];
