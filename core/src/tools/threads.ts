// Threads (VISION §21.1): a message said in Today that clearly continues one
// of the owner's open threads goes there, with a note in Today and Undo.
// Atlas decides that, from the threads listed in its context; nothing guesses
// for it.

import { z } from "zod";
import { defineTool } from "./types";

export const threadMove = defineTool({
  name: "thread_continue",
  kind: "change_own",
  status: "Taking it to the thread.",
  description: [
    "Only in Today: when the owner's message clearly continues one of their open threads (listed in your context with their ids), move it there, then answer as you would in that thread.",
    "The message and your answer go to that thread; Today keeps a note with Undo.",
    "Don't use it for a quick ask, small talk, or anything new, which Today answers itself; long new work is job_own's.",
  ].join(" "),
  input: z.object({ thread: z.string().min(1).max(64).describe("The thread's id, as your context lists it.") }),
  async run(input, ctx) {
    if (!ctx.threads) return { ok: false, output: { error: "Threads can't be reached from this run." } };
    if (ctx.threads.here) return { ok: false, output: { error: "This turn is already in a thread; answer here." } };
    const out = ctx.threads.move(input.thread);
    if (!out.ok) return { ok: false, output: { error: out.error } };
    return {
      ok: true,
      output: { moved_to: out.title, said_there_lately: out.recent || "(nothing yet)" },
      receipt: { text: `Went to ${out.title}`, undo: { kind: "thread.move", run: ctx.run_id, from: null, to: input.thread } },
    };
  },
});
