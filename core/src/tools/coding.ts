// Coding jobs (VISION §8.2). Two sets of tools:
//
// - the owner's runs start a job, find the repo, pass an answer or a word to
//   a job, and look at how jobs are doing;
// - a job's own decisions (Atlas as the middleman, between the coding agent
//   and the owner) answer the agent, ask the owner, run a command in the
//   job's repo, and finish or give up. Those run in the parent agent: the
//   helper only sees their shape.

import { z } from "zod";
import { defineTool, fail, type Tool } from "./types";

/** How hard a coding agent thinks, for agents that take it (Claude Code's effort levels). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// --- the owner's runs ------------------------------------------------------------------

export const codeRepos = defineTool({
  name: "code_repos",
  kind: "look",
  status: "Looking through your repos.",
  description:
    "List the owner's code repositories (from their code host, such as GitHub), most recently changed first, to find the one they mean before starting a coding job ('my budget app'). Match by name and description; if two fit, ask which.",
  input: z.object({ match: z.string().max(100).optional().describe("Words to narrow the list: 'budget'.") }),
  async run(input, ctx) {
    if (!ctx.coding) return fail("Coding jobs can't be started from here.");
    try {
      const all = await ctx.coding.repos();
      const words = (input.match ?? "").toLowerCase().split(/\W+/).filter(Boolean);
      const hit = (r: { repo: string; about?: string }) => words.some((w) => `${r.repo} ${r.about ?? ""}`.toLowerCase().includes(w));
      const list = words.length && all.some(hit) ? all.filter(hit) : all;
      return { ok: true, output: { repos: list.slice(0, 30) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const codeJob = defineTool({
  name: "code_job",
  kind: "change_own",
  status: "Starting a coding job.",
  timeoutMs: 60_000,
  description: [
    "Start a coding job: a coding agent (Codex or Claude Code, whichever the owner set up) works on one of the owner's repos in the workspace, on a new branch, while you act as the middleman: you answer its routine questions, bring the owner only real decisions, review its work and open a pull request. Nothing is merged.",
    "Use it for real changes to a codebase ('fix the failing test in my budget app', 'add dark mode to Keyframes'). Find the repo with code_repos first unless the owner named it exactly.",
    "Write `task` as a complete brief for the agent: what to change and why, what done looks like, anything the owner said about how. It runs in the background: tell the owner in a sentence it's started and where to watch it (Home → Jobs), then end your turn.",
  ].join(" "),
  input: z.object({
    title: z.string().min(1).max(80).describe("A few words for the job, as the owner would say it: 'Budget app: failing test'."),
    repo: z.string().min(3).max(140).describe("The repository, as owner/name."),
    task: z.string().min(1).max(8_000).describe("The complete brief for the coding agent."),
    agent: z
      .string()
      .max(40)
      .optional()
      .describe("Which coding agent, when the owner asked for one: 'codex' or 'claude-code'. Default: the one set up first."),
    base: z.string().max(120).optional().describe("The branch to start from. Default: the repo's default branch."),
    model: z.string().max(80).optional().describe("The agent's model, when the owner named one: 'claude-opus-5-5'."),
    effort: z.enum(EFFORTS).optional().describe("How hard the agent thinks, when the owner said: low, medium, high, xhigh or max."),
  }),
  async run(input, ctx) {
    if (!ctx.coding) return fail("Coding jobs can't be started from here.");
    try {
      const job = await ctx.coding.start({ ...input, asked_in: ctx.run_id });
      return {
        ok: true,
        output: {
          started: job.id,
          agent: job.agent,
          branch: job.branch,
          note: "It's working in the background. Tell the owner in a sentence, then end your turn.",
        },
        receipt: { text: `Started a coding job · ${input.title}` },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const jobAnswer = defineTool({
  name: "job_answer",
  kind: "change_own",
  status: "Passing that on to the job.",
  description:
    "Pass the owner's words to a coding job: the answer to a question it's waiting on, or a change of direction while it works ('use the existing date helper instead'). Use the job's id from the jobs in context or jobs_look. Pass their words as they meant them, in a sentence or two.",
  input: z.object({
    id: z.string().min(3).max(64).describe("The coding job's id."),
    text: z.string().min(1).max(4_000).describe("What the owner said, for the job."),
  }),
  async run(input, ctx) {
    if (!ctx.coding) return fail("Coding jobs can't be reached from here.");
    const out = await ctx.coding.answer(input.id, input.text);
    return out.ok ? { ok: true, output: { done: out.text } } : fail(out.text);
  },
});

export const jobsLook = defineTool({
  name: "jobs_look",
  kind: "look",
  status: "Checking on the job.",
  description:
    "How coding jobs and the jobs you own are doing, from their state: the step each is on, the last thing done, what it's waiting on (with what the owner is asked to look at, in full, and each step's result), how long it's run and what it's cost, and a coding job's pull request once there is one. Use it for 'how's the budget app job?' (answer in a sentence or two) and when the owner asks to see what a job is waiting on: show it to them as it is.",
  input: z.object({ id: z.string().max(64).optional().describe("One job's id; default all of them from the last day.") }),
  async run(input, ctx) {
    if (!ctx.coding) return fail("Coding jobs can't be reached from here.");
    return { ok: true, output: { jobs: ctx.coding.look(input.id) } };
  },
});

export const codingTools: Tool[] = [codeRepos, codeJob, jobAnswer, jobsLook];

// --- a job's own decisions (Atlas as the middleman) -------------------------------------

/** These run in the parent, which holds the job: a helper only has their shape. */
const inParent = async () => fail("This runs in Atlas, not here.");

export const agentReply = defineTool({
  name: "agent_reply",
  kind: "change_own",
  status: "Answering the coding agent.",
  description: [
    "Send the coding agent your answer or next instruction, and let it carry on. Use it to answer a routine question yourself (which test runner, where a file is, a naming choice the project already shows), to send it back when its work isn't right yet (say exactly what's wrong), or to tell it to carry on.",
    "When you answer one of its questions, fill `answered` with the question, your answer and where the answer came from (a file in the repo, the owner's notes, the project's conventions), so the owner sees it in Jobs.",
    "This ends your turn on the job.",
  ].join(" "),
  input: z.object({
    text: z.string().min(1).max(8_000).describe("What to tell the agent, as you'd say it to a capable engineer."),
    answered: z
      .object({ question: z.string().max(500), answer: z.string().max(1_000), source: z.string().max(300) })
      .optional()
      .describe("The question you answered, and where your answer came from."),
  }),
  run: inParent,
});

export const ownerAsk = defineTool({
  name: "owner_ask",
  kind: "change_own",
  status: "Asking the owner.",
  description: [
    "Bring the owner one real decision: something only they can choose (dropping or keeping an API, a trade-off with no right answer, anything that changes what they asked for, or costs money). Ask in one plain question, with the choices when there are a few. Never for something the repo, their notes or good practice answers.",
    "The job waits for their answer, which comes back to the agent. This ends your turn on the job.",
  ].join(" "),
  input: z.object({
    question: z.string().min(1).max(600).describe("The question, in a sentence the owner can answer from a phone."),
    options: z.array(z.string().min(1).max(80)).max(4).optional().describe("The choices, when there are a few."),
    why: z.string().max(600).optional().describe("What depends on it, in a sentence."),
  }),
  run: inParent,
});

export const siteAsk = defineTool({
  name: "site_ask",
  kind: "change_own",
  status: "Asking about that site.",
  description:
    "Ask the owner to let the workspace reach a website the job needs (the agent said a site was blocked, such as registry.npmjs.org to install packages). The owner is asked once per site and it's remembered. The job waits for their answer. This ends your turn on the job.",
  input: z.object({
    host: z.string().min(3).max(200).describe("The site, as a host name: 'registry.npmjs.org'."),
    why: z.string().min(1).max(300).describe("Why the job needs it, in a few words."),
  }),
  run: inParent,
});

export const jobRun = defineTool({
  name: "job_run",
  kind: "change_own",
  status: "Running it in the job.",
  description:
    "Run a shell command in the job's repo, in the workspace: read a file (cat package.json), see the changes (git diff, git log), or run the tests yourself before you trust the agent's word. It changes only the job's own branch. It reaches only the sites the owner allowed.",
  input: z.object({
    command: z.string().min(1).max(4_000),
    timeout_s: z.number().int().min(5).max(900).optional().describe("Most seconds it may take. Default 300."),
  }),
  run: inParent,
});

export const jobReady = defineTool({
  name: "job_ready",
  kind: "change_own",
  status: "Wrapping up the job.",
  description: [
    "The work is done and you've reviewed it: the diff does what was asked and no more, and the tests pass when you ran them yourself. Atlas then commits what's left, pushes the branch and opens a pull request with your title and description. Nothing is merged; the owner reviews it. For a step of a job you own, nothing is pushed: your title and description go back to that job.",
    "Write `body` for the owner and their reviewers: what changed and why, how it was tested, and anything they should look at. This ends the job.",
  ].join(" "),
  input: z.object({
    title: z.string().min(1).max(120).describe("The pull request's title."),
    body: z.string().min(1).max(6_000).describe("The pull request's description, in Markdown."),
  }),
  run: inParent,
});

export const jobGiveUp = defineTool({
  name: "job_give_up",
  kind: "change_own",
  status: "Stopping the job.",
  description:
    "End the job without a pull request, when it can't be done this way (the agent went in circles, the task needs something the workspace can't reach). Say why, and what would help. The branch is kept. This ends the job.",
  input: z.object({ reason: z.string().min(1).max(1_000) }),
  run: inParent,
});

/** What a job's decision may do: answer, ask, run in the repo, finish or give up. */
export const JOB_TOOLS: Tool[] = [agentReply, ownerAsk, siteAsk, jobRun, jobReady, jobGiveUp];
/** The ones that end a decision. */
export const DECIDING = ["agent_reply", "owner_ask", "site_ask", "job_ready", "job_give_up"];
