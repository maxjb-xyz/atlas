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
import { type Append, append, type LogKind, type LogRow } from "../store/log";
import { getState, setState } from "../store/state";
import { endRun, getRun, startRun } from "../store/runs";
import type { JobView } from "../protocol";
import type { BrainChoice } from "../store/settings";
import { fail, type ToolContext, type ToolResult } from "../tools/types";

/** A helper's budget: room for real work, still bounded (§4.1, §8.1). */
export const HELPER_BUDGET: Budget = { steps: 40, ms: 10 * 60_000 };

/** A job that hasn't ended this long after it started is counted as lost: its budget, plus room for a restart. */
export const LOST_AFTER_MS = HELPER_BUDGET.ms + 10 * 60_000;

/** What a helper may write to the log: its own steps, never words to people (§8.1). */
const HELPER_LOG_KINDS: LogKind[] = ["tool.call", "tool.result", "brain.fallback"];

/** The run trigger of a helper's own run. */
export const helperTrigger = (jobId: string) => `helper:${jobId}`;

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
  /** Deletes a finished helper's own storage. */
  discard(jobId: string): Promise<void>;
  /** Wakes `onAgendaDue` for the job at its lease's end, so a lost helper is noticed on the clock. */
  watch(item: AgendaItem): Promise<void>;
  /**
   * Tells the owner what a job found, when nobody was waiting for it. Not
   * awaited: it runs in line after the run in progress, which may be the one
   * that started the job. The job stays in `unreported` until `reported`.
   */
  report(item: AgendaItem, result: { state: "done" | "failed"; text: string }): void;
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
    await this.#discardFinished();
    const run_id = startRun(sql, { actor: "atlas", trigger: "helper", surface: "none", role: "main" });
    const tools = o.tools.filter((t) => HELPER_TOOLS.some((h) => h.name === t));
    const now = Date.now();
    const created = createItem(sql, {
      kind: "job",
      title: o.title,
      due_at: now,
      state: "running",
      source: { run_id: o.askedIn, via: "chat", detail: { brief: o.brief, helper_run: run_id, tools, chain: o.chain as never } },
    });
    // The helper holds the job's lease; if it runs out before the job ends, the clock counts the job as lost.
    sql.exec(`UPDATE agenda SET lease_until = ? WHERE id = ?`, now + LOST_AFTER_MS, created.id);
    const item = getItem(sql, created.id)!;
    sql.exec(`UPDATE runs SET trigger = ? WHERE id = ?`, helperTrigger(item.id), run_id);
    this.#facets("add", item.id);
    this.#status.set(item.id, null);
    this.#changed();
    try {
      await this.host.watch(item);
      await this.host.launch({ id: item.id, run_id, system: o.system, brief: o.brief, tools, chain: o.chain, budget: HELPER_BUDGET });
    } catch (err) {
      // The asking run hears it from the tool, so it isn't reported again.
      const error = `The helper couldn't start: ${errText(err)}`;
      this.#answered.add(item.id);
      await this.done(item.id, { state: "failed", text: "", steps: 0, error });
      throw new Error(error);
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

  #job(id: string): { item: AgendaItem; run: string; tools: string[]; chain: BrainChoice[] } {
    const item = getItem(this.host.sql, id);
    const detail = item?.source.detail as { helper_run?: string; tools?: string[]; chain?: BrainChoice[] } | undefined;
    if (!item || item.kind !== "job" || item.state !== "running" || !detail?.helper_run) {
      throw new Error(`Job ${id} isn't running anymore.`);
    }
    return { item, run: detail.helper_run, tools: detail.tools ?? [], chain: detail.chain ?? [] };
  }

  async brain(jobId: string, choice: BrainChoice, req: Omit<BrainRequest, "signal">): Promise<BrainEvent[]> {
    const job = this.#job(jobId);
    if (!job.chain.some((c) => brainKey(c) === brainKey(choice))) throw new Error(`${brainKey(choice)} isn't in this job's chain.`);
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
    if (!HELPER_LOG_KINDS.includes(row.kind)) throw new Error(`A helper can't write ${row.kind} rows.`);
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
    else if (!this.#answered.has(jobId)) {
      // Kept until the report is sent, so a restart in between doesn't lose it.
      this.#unreported("add", jobId);
      this.host.report(item, { state, text: outcome.text || error || "" });
    }
  }

  /** Jobs that ended with nobody waiting and haven't been reported yet. */
  unreported(): Array<{ item: AgendaItem; result: { state: "done" | "failed"; text: string } }> {
    return this.#unreported("list")
      .map((id) => ({ item: getItem(this.host.sql, id), out: this.#outcomeOf(id) }))
      .filter((x): x is { item: AgendaItem; out: JobOutcome } => Boolean(x.item && x.out && x.out.state !== "cancelled"))
      .map(({ item, out }) => ({ item, result: { state: out.state as "done" | "failed", text: out.text || out.error || "" } }));
  }

  reported(jobId: string): void {
    this.#unreported("remove", jobId);
  }

  #unreported(op: "add" | "remove" | "list", id?: string): string[] {
    const list = getState<string[]>(this.host.sql, "jobs_unreported") ?? [];
    if (op === "list") return list;
    const next = op === "add" ? [...list.filter((x) => x !== id), id!] : list.filter((x) => x !== id);
    setState(this.host.sql, "jobs_unreported", next.slice(-50));
    return next;
  }

  /** The owner stopped a job (Stop on the Jobs tab). */
  stop(jobId: string): boolean {
    const item = getItem(this.host.sql, jobId);
    if (!item || item.kind !== "job" || item.state !== "running") return false;
    const run = (item.source.detail as { helper_run?: string } | undefined)?.helper_run;
    if (run) endRun(this.host.sql, run, "failed", getRun(this.host.sql, run)?.steps ?? 0, { error: "Stopped by the owner." });
    finish(this.host.sql, jobId, "cancelled", run ?? null, { by: "owner" });
    this.#status.delete(jobId);
    this.#waiting.get(jobId)?.({ state: "cancelled", text: "", error: "Stopped by the owner." });
    this.#waiting.delete(jobId);
    this.#changed();
    this.#abort(jobId);
    return true;
  }

  /**
   * The clock woke a job whose lease ran out: if it's still running, its
   * helper was lost (a restart it didn't come back from, or a call to the
   * parent that never arrived). It ends as failed, with the reason, and the
   * owner is told like any other result.
   */
  async lost(jobId: string, now = Date.now()): Promise<boolean> {
    const item = getItem(this.host.sql, jobId);
    if (!item || item.kind !== "job" || item.state !== "running" || (item.lease_until ?? 0) > now) return false;
    this.#abort(jobId);
    const run = (item.source.detail as { helper_run?: string } | undefined)?.helper_run;
    const steps = run ? (getRun(this.host.sql, run)?.steps ?? 0) : 0;
    const minutes = Math.round(LOST_AFTER_MS / 60_000);
    await this.done(jobId, {
      state: "failed",
      text: "",
      steps,
      error: `The helper stopped answering for ${minutes} minutes, so Atlas gave up on it.`,
    });
    return true;
  }

  #abort(jobId: string): void {
    try {
      this.host.abort(jobId);
    } catch (err) {
      console.error(JSON.stringify({ at: "helpers.abort", job: jobId, error: errText(err) }));
    }
  }

  /** Helpers' own storage (their checkpoints) is deleted once their job has ended. */
  async #discardFinished(): Promise<void> {
    for (const id of this.#facets("list")) {
      if (getItem(this.host.sql, id)?.state === "running") continue;
      try {
        await this.host.discard(id);
        this.#facets("remove", id);
      } catch (err) {
        console.error(JSON.stringify({ at: "helpers.discard", job: id, error: errText(err) }));
      }
    }
  }

  async tidy(): Promise<void> {
    await this.#discardFinished();
  }

  #facets(op: "add" | "remove" | "list", id?: string): string[] {
    const list = getState<string[]>(this.host.sql, "helper_facets") ?? [];
    if (op === "list") return list;
    const next = op === "add" ? [...list.filter((x) => x !== id), id!] : list.filter((x) => x !== id);
    setState(this.host.sql, "helper_facets", next);
    return next;
  }

  list(): JobView[] {
    return this.host.sql
      .exec<{ id: string; title: string; state: string; created_at: number; source: string }>(
        `SELECT id, title, state, created_at, source FROM agenda WHERE kind = 'job' AND (state = 'running' OR updated_at > ?) ORDER BY created_at DESC LIMIT 20`,
        Date.now() - 60 * 60_000,
      )
      .toArray()
      .map((r) => {
        const detail = (JSON.parse(r.source) as { detail?: { helper_run?: string; brief?: string } }).detail;
        const run = detail?.helper_run;
        const out = r.state === "running" ? null : this.#outcomeOf(r.id);
        return {
          id: r.id,
          title: r.title,
          state: r.state === "scheduled" ? "running" : (r.state as JobView["state"]),
          status: this.#status.get(r.id) ?? null,
          steps: run
            ? this.host.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE run_id = ? AND kind = 'tool.call'`, run).one().n
            : 0,
          started_at: r.created_at,
          brief: detail?.brief ?? "",
          result: out ? out.text || out.error || null : null,
          run_id: run ?? null,
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
