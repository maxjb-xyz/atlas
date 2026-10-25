// Jobs Atlas owns (VISION §8.3). Two sets of tools:
//
// - the owner's turns take a piece of long work on (`job_own`); job_answer and
//   jobs_look reach it as they do coding jobs;
// - a job's own turns do the work: a shell in its folder, the web and a
//   browser, notes it keeps, and the moves that end a turn (ask the owner,
//   hand building to a coding agent, start helpers, wait, ask for a site,
//   finish or give up).

import { z } from "zod";
import { parseWhen } from "../time";
import { browserAct, browserClose, browserOpen } from "./browser";
import { EFFORTS } from "./coding";
import { defineTool, fail, type Tool, type ToolResult } from "./types";

const done = (r: { ok: boolean; text: string }): ToolResult => (r.ok ? { ok: true, output: { done: r.text } } : fail(r.text));

// --- the owner's turns ---------------------------------------------------------------------

export const jobOwn = defineTool({
  name: "job_own",
  kind: "change_own",
  status: "Getting started.",
  timeoutMs: 60_000,
  description: [
    "Take on a long piece of work and do it yourself in the background, over hours or days if it needs: 'make a 60-second launch video', 'plan the Lisbon trip', 'get three quotes for the roof'. You work on it in a conversation of your own, with a folder in your workspace, the web, a browser, helpers and the owner's coding agent, and you bring the owner only what only they can give.",
    "Use it for work of many steps, not a quick answer (answer that yourself). A change to one of the owner's code repos is code_job instead.",
    "Write `goal` as what done looks like, with everything the owner said about it, in their words: what they want, how they want it, which coding agent, model and effort should build what's made in code if they said, and when they need to see something before you go on.",
    "Then reply in a line, as yourself ('On it. I'll show you the script first.'): it shows under their message as a card, and you'll tell them as it goes, so don't promise times or say where to look.",
  ].join(" "),
  input: z.object({
    title: z.string().min(1).max(80).describe("A few words for it, as the owner would say it: 'Launch video'."),
    goal: z.string().min(1).max(8_000).describe("What done looks like, with everything the owner said."),
    brain: z.string().max(24).optional().describe("A named brain for it, when the owner asked for one. Default: theirs for long work."),
    deadline: z
      .string()
      .max(40)
      .optional()
      .describe("When it must be done by, when the owner said ('by Friday 5pm'), as a local date-time: YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    if (!ctx.goals) return fail("Long work can't be started from here.");
    try {
      const { deadline: when, ...rest } = input;
      let deadline: number | undefined;
      if (when?.trim()) {
        const at = parseWhen(when, ctx.tz);
        if (!at) return fail(`Couldn't read the deadline "${when}". Use YYYY-MM-DDTHH:mm.`);
        if (at.getTime() <= ctx.now.getTime()) return fail(`${when} has already passed.`);
        deadline = at.getTime();
      }
      const job = await ctx.goals.start({ ...rest, ...(deadline ? { deadline } : {}), asked_in: ctx.run_id, asked_by: ctx.source_log_id });
      return {
        ok: true,
        output: { started: job.id, note: "You're working on it in the background now. Reply in a line as yourself, then end your turn." },
        receipt: { text: `Working on it · ${input.title}` },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

// --- a job's turns -----------------------------------------------------------------------

const Files = z
  .array(
    z.object({
      path: z.string().min(1).max(400).describe("The file, in your folder: 'tracks/neon-rush.mp3'."),
      name: z.string().max(120).optional().describe("Its name as the owner sees it: 'Neon Rush.mp3'."),
    }),
  )
  .max(6);

export const jobNotes = defineTool({
  name: "job_notes",
  kind: "change_own",
  status: "Making a note.",
  description:
    "Rewrite your notes on this work, in full: what you've decided and why, the owner's answers and wishes in their own words, what you tried that failed and why, what's left. You read them at the start of every turn, and they're kept when older parts of this conversation are summarized, so keep them current and short (bullets are fine here).",
  input: z.object({ notes: z.string().min(1).max(12_000) }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(ctx.ownedJob.notes(input.notes));
  },
});

export const jobUpdate = defineTool({
  name: "job_update",
  kind: "change_own",
  status: "Showing what I have.",
  timeoutMs: 120_000,
  description:
    "Tell the owner something worth knowing before you're done, in the thread: something to look at (with its files), a decision you made for them, a change of plan. It doesn't notify them, and you carry on in the same turn. Talk as yourself, in a sentence or two. Don't use it for progress chatter.",
  input: z.object({ text: z.string().min(1).max(2_000), files: Files.optional() }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.update(input));
  },
});

export const jobAsk = defineTool({
  name: "job_ask",
  kind: "change_own",
  status: "Asking you.",
  timeoutMs: 120_000,
  description: [
    "Ask the owner for what only they can give: a choice of taste, their OK before something that can't be undone, a sign-in, a fact only they know. Never ask what you can decide yourself: decide as they would and say what you chose.",
    "It's one message in the thread and in Inbox, with a button per option, and it notifies them; your turn ends and their answer starts your next one.",
    "Put what they need to decide in `content` (the whole script, the plan), and the things themselves in `files` from your folder (the three tracks to play, the images, the cut to watch): they play or show right there in the app and arrive on their chat, so they never have to go and find them. Attach them to the question even if you showed them before: the question is what they answer from. Talk as yourself: 'Three tracks to pick from. I'd go with the first.'",
  ].join(" "),
  input: z.object({
    text: z.string().min(1).max(1_000).describe("The question, in a sentence or two."),
    options: z
      .array(z.string().min(1).max(60))
      .max(6)
      .optional()
      .describe("Answers they can tap, short. They can always answer in words too."),
    content: z.string().max(20_000).optional().describe("What they need to read to decide, in full, in Markdown."),
    files: Files.optional(),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.ask(input));
  },
});

export const jobBuild = defineTool({
  name: "job_build",
  kind: "change_own",
  status: "Handing that to the coding agent.",
  timeoutMs: 60_000,
  description: [
    "Hand building something in code (a video project, a site, a script) to the owner's coding agent (Claude Code or Codex), in repo/ in your folder, where it can read what you made around it. You're its middleman: it asks you what it needs and you answer for the owner. Write `brief` as everything it needs: what to make, from which files, how it should look, how to check it.",
    "Use `agent`, `model` and `effort` when the owner said which ('Claude Code with Opus 5.5 on low'); `minutes` when there's a deadline. Your turn ends; its result starts your next one.",
  ].join(" "),
  input: z.object({
    brief: z.string().min(1).max(12_000),
    agent: z.string().max(40).optional().describe("Which coding agent, by name: 'Claude Code', 'Codex'. Default: the first set up."),
    model: z.string().max(80).optional().describe("The model id it runs, when the owner said: 'claude-opus-5-5'."),
    effort: z.enum(EFFORTS).optional().describe("How hard it thinks, when the owner said."),
    minutes: z.number().int().min(5).max(600).optional().describe("How long it has, when time matters."),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.build(input));
  },
});

export const jobHelpers = defineTool({
  name: "job_helpers",
  kind: "look",
  status: "Starting a few helpers.",
  timeoutMs: 60_000,
  description:
    "Start helpers that read for you in parallel, each from its own brief: comparing many options at once, or reading pages that shouldn't be able to steer you. They can only look; each hands back what it found. Write each brief in full, with exactly what to hand back (a short list with links, a table). Your turn ends; what they found starts your next one. Set `research` for reading widely over hours.",
  input: z.object({
    tasks: z
      .array(z.object({ title: z.string().min(1).max(80), brief: z.string().min(1).max(4_000) }))
      .min(1)
      .max(5),
    research: z.boolean().optional(),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.helpers(input));
  },
});

export const jobWait = defineTool({
  name: "job_wait",
  kind: "change_own",
  status: "Waiting on that.",
  description:
    "Wait until later for something outside you (a reply from someone, a download to be ready, a time the owner gave), then carry on. Your turn ends now; the next starts when the time comes, or sooner if the owner says something.",
  input: z.object({
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    why: z.string().min(1).max(300),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.wait(input));
  },
});

export const jobSite = defineTool({
  name: "job_site",
  kind: "change_own",
  status: "Asking about that site.",
  description:
    "Ask the owner to let your workspace reach a website you need (a command said it was blocked, or you know you'll need it: a music library to download a track, a package registry). They're asked once per site on a card and it's remembered. Ask for the site the files come from, not a search engine. Your turn ends; their answer starts the next.",
  input: z.object({
    host: z.string().min(3).max(200).describe("The site, as a host name: 'pixabay.com'."),
    why: z.string().min(1).max(300).describe("Why you need it, in a few words."),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.site(input));
  },
});

export const jobDeadline = defineTool({
  name: "job_deadline",
  kind: "change_own",
  status: "Changing the deadline.",
  description:
    "Set, move or take away the deadline, when the owner says so: a local date-time (YYYY-MM-DDTHH:mm), or nothing to take it away.",
  input: z.object({ at: z.string().max(40).optional() }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    if (!input.at?.trim()) return done(ctx.ownedJob.deadline(null));
    const at = parseWhen(input.at, ctx.tz);
    if (!at) return fail(`Couldn't read "${input.at}". Use YYYY-MM-DDTHH:mm.`);
    return done(ctx.ownedJob.deadline(at.getTime()));
  },
});

export const jobFinish = defineTool({
  name: "job_finish",
  kind: "change_own",
  status: "Wrapping it up.",
  timeoutMs: 180_000,
  description:
    "It's done: what you made goes to the owner's Library, and your result goes in the thread with the files and notifies them. Write `summary` to the owner as yourself, briefly: what you made, anything you left out and why. Only finish with the real thing made and checked.",
  input: z.object({
    summary: z.string().min(1).max(4_000),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(400),
          name: z.string().max(120).optional(),
          note: z.string().max(300).optional().describe("What it is, for Library."),
        }),
      )
      .max(10)
      .optional(),
  }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.finish(input));
  },
});

export const jobFail = defineTool({
  name: "job_fail",
  kind: "change_own",
  status: "Stopping here.",
  description:
    "It can't be done this way and nothing else would work: it ends, and the owner hears why in the thread. Say what you tried and what would make it possible, as yourself, briefly. Ask them first (job_ask) when a choice of theirs could still save it.",
  input: z.object({ why: z.string().min(1).max(2_000) }),
  async run(input, ctx) {
    if (!ctx.ownedJob) return fail("This only works on work you own.");
    return done(await ctx.ownedJob.fail(input.why));
  },
});

/** The start and the end of long output: errors are usually at the end. */
const tail = (s: string, n = 12_000) =>
  s.length <= n ? s : `${s.slice(0, 2_000)}\n… (${s.length - n} characters left out) …\n${s.slice(-(n - 2_000))}`;

export const folderRun = defineTool({
  name: "folder_run",
  kind: "change_own",
  status: "Working on it.",
  timeoutMs: 16 * 60_000,
  description: [
    "Run a shell command in your folder in the workspace: a Linux computer with bash, Python 3 (pandas, openpyxl, python-docx, reportlab, matplotlib, requests), Node, ffmpeg, Chromium (/usr/bin/chromium), git, curl, jq and sqlite3. It starts in your folder, which keeps its files between turns.",
    "Make what you make there. Only websites the owner allowed are reachable; a blocked one is listed, and job_site asks for it.",
  ].join(" "),
  input: z.object({
    command: z.string().min(1).max(20_000).describe("The bash command or script to run, from your folder."),
    timeout_s: z.number().int().min(5).max(900).optional().describe("Most seconds it may take. Default 120."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace) return fail("There's no folder to work in here.");
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

/** A job's turn's own moves (§8.3). */
export const MOVES: Tool[] = [jobNotes, jobUpdate, jobAsk, jobBuild, jobHelpers, jobWait, jobSite, jobDeadline, jobFinish, jobFail];
/** What a helper reading for a job may use beyond its lookups: the browser, to read sites built by script. */
export const READ_TOOLS: Tool[] = [browserOpen, browserAct, browserClose];
