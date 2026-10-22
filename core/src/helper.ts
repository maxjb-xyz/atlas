// A helper (VISION §8.1): a short-lived child agent that runs the one loop
// on one job, with a narrower brief, fewer tools and no personality. It is
// an Agents SDK sub-agent (a facet with its own storage, beside its parent),
// and its run is a durable fiber: it saves a checkpoint after each step and
// picks up from there after a restart.
//
// A helper holds nothing of the owner's. Every brain call, tool call and log
// row goes through its parent, so the parent's router, tools and log stay
// the only ones (rule 3), and a helper can never do more than its parent let
// it (§8.1).

import { Agent, type FiberContext } from "agents";
import type { Brain, BrainEvent, BrainRequest } from "./brains/types";
import { BrainRouter } from "./brains/router";
import { type Budget, type Checkpoint, runLoop } from "./loop";
import type { Append, LogRow } from "./store/log";
import type { BrainChoice } from "./store/settings";
import { recall } from "./tools/memory";
import { calendarRead } from "./tools/calendar";
import { reminderList } from "./tools/reminders";
import type { Tool, ToolResult } from "./tools/types";

/** What a helper may use: looking only. Helpers can't change the owner's things or save facts about them (§5.4). */
export const HELPER_TOOLS: Tool[] = [recall, calendarRead, reminderList];

export interface HelperJob {
  /** The agenda item for the job; also the helper's name. */
  id: string;
  /** The helper's run, in the parent's runs table. */
  run_id: string;
  system: string;
  brief: string;
  tools: string[];
  chain: BrainChoice[];
  budget: Budget;
}

export interface HelperOutcome {
  state: "replied" | "failed";
  text: string;
  steps: number;
  error?: string;
}

/** What the parent offers a helper, over RPC. */
export interface HelperHost {
  helperBrain(jobId: string, choice: BrainChoice, req: Omit<BrainRequest, "signal">): Promise<BrainEvent[]>;
  helperTool(jobId: string, name: string, input: unknown): Promise<ToolResult>;
  helperLog(jobId: string, row: Append): Promise<LogRow>;
  helperDone(jobId: string, outcome: HelperOutcome): Promise<void>;
}

interface Snapshot {
  job: HelperJob;
  at: Checkpoint | null;
}

const FIBER = "helper";

export class HelperAgent extends Agent<Env> {
  /** Starts the job and returns at once; the result reaches the parent through `helperDone`. */
  async begin(job: HelperJob): Promise<void> {
    void this.runFiber(FIBER, (f) => this.#work(job, null, f));
  }

  /** After a restart cut the job short: carry on from the last checkpoint. */
  override async onFiberRecovered(ctx: { name: string; snapshot: unknown | null }): Promise<void> {
    const snap = ctx.snapshot as Snapshot | null;
    if (ctx.name !== FIBER || !snap?.job) return;
    void this.runFiber(FIBER, (f) => this.#work(snap.job, snap.at, f));
  }

  /** For tests: the same path as a recovery after a restart. */
  async resumeFrom(snapshot: Snapshot): Promise<void> {
    await this.onFiberRecovered({ name: FIBER, snapshot });
  }

  async #work(job: HelperJob, resume: Checkpoint | null, f: FiberContext): Promise<void> {
    f.stash({ job, at: resume } satisfies Snapshot);
    const host = (await this.parentAgent(
      // Imported lazily: the parent module imports this one.
      (await import("./agent")).PersonAgent as never,
    )) as unknown as HelperHost;

    const tools = HELPER_TOOLS.filter((t) => job.tools.includes(t.name)).map(
      (t): Tool => ({ ...t, run: async (input: unknown) => host.helperTool(job.id, t.name, input) }) as Tool,
    );
    const router = new BrainRouter((choice) => proxyBrain(host, job.id, choice));
    let outcome: HelperOutcome;
    try {
      const res = await runLoop(
        { log: (row) => host.helperLog(job.id, row), router, chain: job.chain, toolContext: {} as never },
        {
          runId: job.run_id,
          role: "main",
          surface: "none",
          system: job.system,
          messages: [{ role: "user", content: job.brief }],
          tools,
          budget: job.budget,
          joiner: "\n\n",
          effort: "medium",
          // The parent runs each call to the end before answering, so allow for a whole answer.
          firstEventMs: 150_000,
          ...(resume ? { resume } : {}),
          checkpoint: (at) => f.stash({ job, at } satisfies Snapshot),
        },
        () => {},
      );
      outcome = {
        state: res.state === "replied" ? "replied" : "failed",
        text: res.text,
        steps: res.steps,
        ...(res.error ? { error: res.error } : {}),
      };
    } catch (err) {
      outcome = { state: "failed", text: "", steps: 0, error: err instanceof Error ? err.message : String(err) };
    }
    await host.helperDone(job.id, outcome);
  }
}

/** A brain that asks the parent to make the call, so the parent's chain, health and sign-ins stay the only ones. */
function proxyBrain(host: HelperHost, jobId: string, choice: BrainChoice): Brain {
  return {
    provider: choice.provider,
    model: choice.model,
    async *stream(req) {
      const { signal: _signal, ...rest } = req;
      for (const e of await host.helperBrain(jobId, choice, rest)) yield e;
    },
  };
}
