// The parent's side of helpers (§8.1): starting a job, answering a helper's
// brain, tool and log calls, and taking its result. A job is an agenda item
// of kind "job" (the one clock, §4.3), and the helper's work is a run with
// its own saved final state, written to this agent's log.

import type { BrainRouter } from "../brains/router";
import { type Brain, type BrainEvent, type BrainRequest, brainKey } from "../brains/types";
import { HELPER_TOOLS, type HelperJob, type HelperOutcome } from "../helper";
import type { Budget } from "../loop";
import { type AgendaItem, createItem, finish, getItem } from "../store/agenda";
import type { Sql } from "../store/db";
import { type Append, append, type LogRow } from "../store/log";
import { endRun, getRun, startRun } from "../store/runs";
import type { JobView } from "../protocol";
import type { BrainChoice } from "../store/settings";
import { fail, type ToolContext, type ToolResult } from "../tools/types";

/** A helper's budget: room for real work, still bounded (§4.1, §8.1). */
export const HELPER_BUDGET: Budget = { steps: 40, ms: 10 * 60_000 };

/** A job that hasn't ended this long after its budget is counted as lost. */
const LOST_AFTER_MS = HELPER_BUDGET.ms + 10 * 60_000;

export interface HelperDeskHost {
  sql: Sql;
  router: BrainRouter;
  makeBrain(choice: BrainChoice): Brain | null;
  /** A tool context for the helper's run, as the parent sees it. */
  toolContext(runId: string): ToolContext;
  /** Starts the helper as a sub-agent and hands it the job. */
  launch(job: HelperJob): Promise<void>;
  /** Stops a running helper. */
  abort(jobId: string): void;
  /** Tells the owner what a job found, when nobody was waiting for it. */
  report(item: AgendaItem, result: { state: "done" | "failed"; text: string }): Promise<void>;
  rows(rows: LogRow[]): void;
  jobsChanged(jobs: JobView[]): void;
}

export interface JobOutcome {
  state: "done" | "failed" | "cancelled";
  text: string;
  error?: string;
}

export class HelperDesk {
  #status = new Map<string, string | null>();
  #waiting = new Map<string, (o: JobOutcome) => void>();
  /** Jobs whose result went into the run that asked, so they aren't reported again. */
  #answered = new Set<string>();

  constructor(private readonly host: HelperDeskHost) {}

  async start(o: {
    title: string;
    brief: string;
    system: string;
    tools: string[];
    chain: BrainChoice[];
    askedIn: string;
  }): Promise<AgendaItem> {
    const { sql } = this.host;
    const run_id = startRun(sql, { actor: "atlas", trigger: "helper", surface: "none", role: "main" });
    const tools = o.tools.filter((t) => HELPER_TOOLS.some((h) => h.name === t));
    const item = createItem(sql, {
      kind: "job",
      title: o.title,
      due_at: Date.now(),
      state: "running",
      source: { run_id: o.askedIn, via: "chat", detail: { brief: o.brief, helper_run: run_id, tools } },
    });
    sql.exec(`UPDATE runs SET trigger = ? WHERE id = ?`, `job:${item.id}`, run_id);
    this.#status.set(item.id, null);
    this.#changed();
    try {
      await this.host.launch({ id: item.id, run_id, system: o.system, brief: o.brief, tools, chain: o.chain, budget: HELPER_BUDGET });
    } catch (err) {
      await this.done(item.id, { state: "failed", text: "", steps: 0, error: `The helper couldn't start: ${errText(err)}` });
    }
    return getItem(sql, item.id)!;
  }

  /** Waits for a job's result, up to `ms`. Null means it's still going and will be reported when it ends. */
  wait(id: string, ms: number): Promise<JobOutcome | null> {
    const item = getItem(this.host.sql, id);
    if (!item || item.kind !== "job") return Promise.resolve(null);
    if (item.state !== "running") return Promise.resolve(this.#outcomeOf(id));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        resolve(null);
      }, ms);
      this.#waiting.set(id, (o) => {
        clearTimeout(timer);
        this.#answered.add(id);
        resolve(o);
      });
    });
  }

  // --- what a helper asks of its parent ------------------------------------------

  #job(id: string): { item: AgendaItem; run: string; tools: string[] } {
    const item = getItem(this.host.sql, id);
    const detail = item?.source.detail as { helper_run?: string; tools?: string[] } | undefined;
    if (!item || item.kind !== "job" || item.state !== "running" || !detail?.helper_run) {
      throw new Error(`Job ${id} isn't running anymore.`);
    }
    return { item, run: detail.helper_run, tools: detail.tools ?? [] };
  }

  async brain(jobId: string, choice: BrainChoice, req: Omit<BrainRequest, "signal">): Promise<BrainEvent[]> {
    this.#job(jobId);
    const brain = this.host.makeBrain(choice);
    if (!brain) throw new Error(`${brainKey(choice)} isn't set up.`);
    const events: BrainEvent[] = [];
    try {
      for await (const e of brain.stream({ ...req, signal: AbortSignal.timeout(140_000) })) events.push(e);
      this.host.router.markOk(brain);
      return events;
    } catch (err) {
      this.host.router.markFailed(brain, err);
      throw new Error(errText(err));
    }
  }

  async tool(jobId: string, name: string, input: unknown): Promise<ToolResult> {
    const job = this.#job(jobId);
    const tool = HELPER_TOOLS.find((t) => t.name === name);
    if (!tool || !job.tools.includes(name)) return fail(`This helper can't use ${name}.`);
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) return fail(`Those arguments don't fit: ${parsed.error.message}`);
    if (tool.status) {
      this.#status.set(jobId, tool.status);
      this.#changed();
    }
    return tool.run(parsed.data as never, this.host.toolContext(job.run));
  }

  async log(jobId: string, row: Append): Promise<LogRow> {
    const job = this.#job(jobId);
    const written = append(this.host.sql, { ...row, actor: "atlas", run_id: job.run, surface: "none" });
    if (row.kind === "tool.result" && written.body.receipt != null) this.host.rows([written]);
    return written;
  }

  async done(jobId: string, outcome: HelperOutcome): Promise<void> {
    const item = getItem(this.host.sql, jobId);
    if (!item || item.state !== "running") return;
    const run = (item.source.detail as { helper_run?: string } | undefined)?.helper_run;
    const state = outcome.state === "replied" && outcome.text.trim() ? "done" : "failed";
    const error = state === "failed" ? (outcome.error ?? "The helper handed back nothing.") : undefined;
    if (run) endRun(this.host.sql, run, state === "done" ? "replied" : "failed", outcome.steps, error ? { error } : {});
    append(this.host.sql, {
      actor: "atlas",
      kind: "job.result",
      run_id: run ?? null,
      body: { item_id: jobId, title: item.title, state, text: outcome.text, steps: outcome.steps, ...(error ? { error } : {}) },
    });
    finish(this.host.sql, jobId, state, run ?? null, error ? { error } : {});
    this.#status.delete(jobId);
    this.#changed();
    const result: JobOutcome = { state, text: outcome.text, ...(error ? { error } : {}) };
    const waiter = this.#waiting.get(jobId);
    this.#waiting.delete(jobId);
    if (waiter) waiter(result);
    else if (!this.#answered.has(jobId)) await this.host.report(item, { state, text: outcome.text || error || "" });
  }

  /** The owner stopped a job (Stop on the Jobs tab). */
  stop(jobId: string): boolean {
    const item = getItem(this.host.sql, jobId);
    if (!item || item.kind !== "job" || item.state !== "running") return false;
    this.host.abort(jobId);
    const run = (item.source.detail as { helper_run?: string } | undefined)?.helper_run;
    if (run) endRun(this.host.sql, run, "failed", getRun(this.host.sql, run)?.steps ?? 0, { error: "Stopped by the owner." });
    finish(this.host.sql, jobId, "cancelled", run ?? null, { by: "owner" });
    this.#status.delete(jobId);
    this.#waiting.get(jobId)?.({ state: "cancelled", text: "", error: "Stopped by the owner." });
    this.#waiting.delete(jobId);
    this.#changed();
    return true;
  }

  /** Jobs that ran far past their budget without ending were lost; they end as failed, with the reason. */
  sweep(now = Date.now()): void {
    const lost = this.host.sql
      .exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'job' AND state = 'running' AND created_at < ?`, now - LOST_AFTER_MS)
      .toArray();
    for (const { id } of lost) {
      const item = getItem(this.host.sql, id)!;
      const run = (item.source.detail as { helper_run?: string } | undefined)?.helper_run;
      const error = "The helper stopped answering, so Atlas gave up on it.";
      if (run) endRun(this.host.sql, run, "failed", 0, { error });
      finish(this.host.sql, id, "failed", run ?? null, { error });
    }
  }

  list(): JobView[] {
    return this.host.sql
      .exec<{ id: string; title: string; state: string; created_at: number; source: string }>(
        `SELECT id, title, state, created_at, source FROM agenda WHERE kind = 'job' AND (state = 'running' OR updated_at > ?) ORDER BY created_at DESC LIMIT 20`,
        Date.now() - 60 * 60_000,
      )
      .toArray()
      .map((r) => {
        const run = (JSON.parse(r.source) as { detail?: { helper_run?: string } }).detail?.helper_run;
        return {
          id: r.id,
          title: r.title,
          state: r.state === "scheduled" ? "running" : (r.state as JobView["state"]),
          status: this.#status.get(r.id) ?? null,
          steps: run
            ? this.host.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE run_id = ? AND kind = 'tool.call'`, run).one().n
            : 0,
          started_at: r.created_at,
        };
      });
  }

  #outcomeOf(id: string): JobOutcome | null {
    const row = this.host.sql
      .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'job.result' AND json_extract(body, '$.item_id') = ? LIMIT 1`, id)
      .toArray()[0];
    if (!row) return null;
    const b = JSON.parse(row.body) as { state: "done" | "failed"; text: string; error?: string };
    return { state: b.state, text: b.text, ...(b.error ? { error: b.error } : {}) };
  }

  #changed(): void {
    this.host.jobsChanged(this.list());
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
