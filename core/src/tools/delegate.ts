// Handing work to a helper (§8.1): to keep this conversation's context
// clean (read a lot, hand back a little), or to keep working in the
// background while the owner gets on with things.

import { z } from "zod";
import { HELPER_TOOLS } from "../helper";
import { defineTool, fail } from "./types";

/** How long the asking run waits before the job carries on in the background. */
export const WAIT_MS = 150_000;

const HELPER_TOOL_NAMES = HELPER_TOOLS.map((t) => t.name) as [string, ...string[]];

export const delegate = defineTool({
  name: "delegate",
  kind: "look",
  status: "Handing this to a helper.",
  timeoutMs: WAIT_MS + 20_000,
  description: [
    "Hand one piece of work to a helper: a quiet copy of you with only lookup tools, its own budget, and no conversation.",
    "Use it for work that needs many lookups or a lot of reading, such as going through months of conversations or a long stretch of the calendar, so only the result comes back here.",
    "Write `task` as a complete brief: what to find or work out, where to look, and exactly what to hand back (a short list, a table, one answer). The helper sees nothing of this conversation but the brief.",
    "With `wait` true (the default) you get the result in this turn, unless it runs past two and a half minutes; then it keeps going and you report it to the owner when it's done.",
    "With `wait` false it works in the background and you tell the owner when it's done; in a voice conversation, say you'll get back to them instead of waiting.",
    "Helpers can only look: they can't change anything or save anything.",
  ].join(" "),
  input: z.object({
    title: z
      .string()
      .min(1)
      .max(80)
      .describe("A few words for the job, as the owner would see it in Jobs: 'Riverside notes since August'."),
    task: z.string().min(1).max(4_000).describe("The complete brief."),
    tools: z.array(z.enum(HELPER_TOOL_NAMES)).min(1).optional().describe("The lookups it may use. Default: all of them."),
    wait: z.boolean().optional().describe("Wait for the result in this turn. Default true."),
  }),
  async run(input, ctx) {
    if (!ctx.helpers) return fail("Helpers can't start helpers of their own.");
    const job = await ctx.helpers.start({ title: input.title, brief: input.task, tools: input.tools ?? HELPER_TOOL_NAMES });
    if (input.wait === false) {
      return { ok: true, output: { job_id: job.id, running: "It works in the background; you'll report what it found when it's done." } };
    }
    const out = await ctx.helpers.wait(job.id, WAIT_MS);
    if (!out)
      return {
        ok: true,
        output: { job_id: job.id, running: "Still going. It carries on in the background, and you'll report it when it's done." },
      };
    if (out.state !== "done") return fail(`The helper didn't finish: ${out.error ?? out.state}.`);
    return { ok: true, output: { job_id: job.id, result: out.text } };
  },
});
