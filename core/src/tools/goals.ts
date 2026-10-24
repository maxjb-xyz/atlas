// Jobs Atlas owns (VISION §8.3). Three sets of tools:
//
// - the owner's runs hand Atlas a goal (`job_own`); job_answer and jobs_look
//   reach these jobs as they do coding jobs;
// - a job's looks make one move each: start a step, ask at a checkpoint,
//   change the plan, mark a step, finish or give up;
// - a step's helper works in the job's folder, with a shell there.

import { z } from "zod";
import { defineTool, fail, type Tool } from "./types";

const Kind = z
  .enum(["work", "research", "checkpoint"])
  .describe(
    "work: a helper does it with a shell in the job's folder (write, compute, convert, build files). research: a helper reads and compares on the web. checkpoint: the owner looks and says yes or changes it.",
  );

// --- the owner's runs ------------------------------------------------------------------

export const jobOwn = defineTool({
  name: "job_own",
  kind: "change_own",
  status: "Starting the job.",
  timeoutMs: 60_000,
  description: [
    "Take on a long piece of work as a job you own: a goal with a plan of steps, a folder of its own in the workspace, and checkpoints where the owner looks before you go on ('make a 60-second launch video', 'plan the Lisbon trip', 'get three quotes for the roof').",
    "Use it for work of many steps that runs over hours or days, not for a quick answer (answer that yourself, or delegate one lookup). A change to one of the owner's code repos is a coding job (code_job) instead.",
    "Write `goal` as what done looks like, in the owner's words and with everything they said about it. Plan the steps in order, a few words each; put a checkpoint wherever the owner should see something before you go on (the script before the voiceover, the cut before it's final). You can change the plan as you go.",
    "It runs in the background: tell the owner in a sentence it's started and where to watch it (Home → Jobs), then end your turn.",
  ].join(" "),
  input: z.object({
    title: z.string().min(1).max(80).describe("A few words for the job, as the owner would say it: 'Launch video'."),
    goal: z.string().min(1).max(8_000).describe("What done looks like, with everything the owner said."),
    steps: z
      .array(z.object({ title: z.string().min(1).max(160), kind: Kind }))
      .min(1)
      .max(30)
      .describe("The plan, in order."),
    brain: z
      .string()
      .max(24)
      .optional()
      .describe("A named brain for its steps, when the owner asked for one. Default: theirs for a job's work."),
  }),
  async run(input, ctx) {
    if (!ctx.goals) return fail("Jobs can't be started from here.");
    try {
      const job = await ctx.goals.start({ ...input, asked_in: ctx.run_id });
      return {
        ok: true,
        output: {
          started: job.id,
          folder: job.folder,
          note: "It's under way in the background. Tell the owner in a sentence, then end your turn.",
        },
        receipt: { text: `Started a job · ${input.title}` },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

// --- a job's looks ---------------------------------------------------------------------

const done = (out: { ok: boolean; text: string }) => (out.ok ? { ok: true, output: { done: out.text } } : fail(out.text));

export const jobStep = defineTool({
  name: "job_step",
  kind: "change_own",
  status: "Working on the next step.",
  description: [
    "Start the job's next step: a helper does it, in the job's folder, from your brief, and its result comes back to your next look.",
    "The helper sees nothing but the brief: give it the goal, what earlier steps made (file names in the folder, decisions, the owner's edits) and exactly what to hand back.",
    "One step at a time. This ends your turn on the job.",
  ].join(" "),
  input: z.object({
    step: z.string().min(1).max(8).describe("The step's id: 's2'."),
    brief: z.string().min(1).max(12_000).describe("The helper's complete brief."),
    brain: z.string().max(24).optional().describe("A named brain for this step only, when another suits it better."),
  }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(await ctx.goalLook.step(input));
  },
});

export const jobCheckpoint = defineTool({
  name: "job_checkpoint",
  kind: "change_own",
  status: "Saving where the job is.",
  description: [
    "Ask the owner at a checkpoint, or about a decision only they can make: one question in Inbox, with what they should look at in `content` (the script, the itinerary, the three quotes side by side).",
    "Offer `options` when the answer is a choice; they can always write their own. Their answer, edits included, comes back to your next look, and the job waits until then.",
    "This ends your turn on the job.",
  ].join(" "),
  input: z.object({
    step: z.string().max(8).optional().describe("The checkpoint step it's for, if any."),
    text: z.string().min(1).max(600).describe("The question, as you'd ask it."),
    content: z.string().max(20_000).optional().describe("What they should look at, in full."),
    options: z.array(z.string().min(1).max(60)).max(4).optional(),
  }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(await ctx.goalLook.checkpoint(input));
  },
});

export const jobPlan = defineTool({
  name: "job_plan",
  kind: "change_own",
  status: "Planning the job.",
  description:
    "Change the job's plan when what came back changes it: add steps (after one, or at the end) and drop steps that haven't started. The owner sees the plan in Jobs.",
  input: z.object({
    add: z
      .array(z.object({ title: z.string().min(1).max(160), kind: Kind, after: z.string().max(8).optional() }))
      .max(10)
      .optional(),
    drop: z.array(z.string().max(8)).max(10).optional(),
  }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(ctx.goalLook.plan(input));
  },
});

export const jobMark = defineTool({
  name: "job_mark",
  kind: "change_own",
  status: "Updating the job.",
  description:
    "Mark a step done (what it needed is already there, or you did it yourself in this look) or skipped (no longer needed), with a line on what came of it.",
  input: z.object({
    step: z.string().min(1).max(8),
    state: z.enum(["done", "skipped"]),
    result: z.string().max(2_000).optional(),
  }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(ctx.goalLook.mark(input));
  },
});

export const jobFinish = defineTool({
  name: "job_finish",
  kind: "change_own",
  status: "Finishing the job.",
  description: [
    "Finish the job when its goal is met: keep what it made for the owner (files in its folder go into Library), and say what it came to in a few sentences for the owner.",
    "Only when every step that matters is done and the last checkpoint is answered.",
  ].join(" "),
  input: z.object({
    summary: z.string().min(1).max(4_000).describe("What the job came to, for the owner."),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(500).describe("The file, relative to the job's folder or absolute."),
          name: z.string().max(120).optional(),
          note: z.string().max(300).optional(),
        }),
      )
      .max(20)
      .optional(),
  }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(await ctx.goalLook.finish(input));
  },
});

export const jobFail = defineTool({
  name: "job_fail",
  kind: "change_own",
  status: "Stopping the job.",
  description: "End the job when its goal can't be met, with why in a sentence or two and what would make it possible.",
  input: z.object({ why: z.string().min(1).max(2_000) }),
  async run(input, ctx) {
    if (!ctx.goalLook) return fail("This only works in a job's look.");
    return done(await ctx.goalLook.fail(input.why));
  },
});

/** A job's looks: its moves, and a look at its folder. */
export const lookTools: Tool[] = [jobStep, jobCheckpoint, jobPlan, jobMark, jobFinish, jobFail];

// --- a step's helper ---------------------------------------------------------------------

/** The start and the end of long output: errors are usually at the end. */
const tail = (s: string, n = 12_000) =>
  s.length <= n ? s : `${s.slice(0, 2_000)}\n… (${s.length - n} characters left out) …\n${s.slice(-(n - 2_000))}`;

export const folderRun = defineTool({
  name: "folder_run",
  kind: "change_own",
  status: "Working in the job's folder.",
  timeoutMs: 16 * 60_000,
  description: [
    "Run a shell command in the job's folder in the workspace: a Linux computer with bash, Python 3 (pandas, openpyxl, python-docx, reportlab, matplotlib, requests), Node, ffmpeg if installed, git, curl, jq and sqlite3. It starts in the job's folder, which keeps its files.",
    "Write what you make into the folder, so the job's next steps and the owner find it. Only websites the owner allowed are reachable; a blocked one is listed, and asking for sites is the job's to do, not yours: say which you needed.",
  ].join(" "),
  input: z.object({
    command: z.string().min(1).max(20_000).describe("The bash command or script to run, from the job's folder."),
    timeout_s: z.number().int().min(5).max(900).optional().describe("Most seconds it may take. Default 120."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace) return fail("This helper has no folder to work in.");
    try {
      const r = await ctx.workspace.run(input.command, { run_id: ctx.run_id, timeout_s: input.timeout_s ?? 120 });
      return {
        ok: true,
        output: {
          exit: r.exit,
          ...(r.exit === 124 ? { timed_out: `It ran past ${input.timeout_s ?? 120} seconds and was stopped.` } : {}),
          output: tail(r.output) || "(nothing printed)",
          ...(r.blocked.length ? { blocked: r.blocked } : {}),
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

/** What a step's helper gets beyond its lookups. */
export const STEP_TOOLS: Tool[] = [folderRun];
