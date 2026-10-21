import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import type { Brain, BrainEvent, BrainRequest } from "../src/brains/types";
import { BrainRouter } from "../src/brains/router";
import { compact, KEEP_MESSAGES, planCompaction, SAVE_NOTE, SUMMARY_NOTE } from "../src/compaction";
import { history, latestSummary, systemPrompt } from "../src/context";
import { migrate, type Sql } from "../src/store/db";
import { append, thread } from "../src/store/log";
import { standingFacts } from "../src/store/records";
import { readSettings } from "../src/store/settings";
import { startRun } from "../src/store/runs";
import { getState } from "../src/store/state";
import type { ToolContext } from "../src/tools/types";
import { env, fakeCalendar, fakeEmbedder } from "./helpers";

const TZ = "America/New_York";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`c-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

/** `n` exchanges of about `size` characters each side. */
function talk(sql: Sql, n: number, size = 400, first = "") {
  for (let i = 0; i < n; i++) {
    const runId = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
    const said = i === 0 && first ? first : `message ${i} ${"x".repeat(size)}`;
    append(sql, { actor: "owner", kind: "message.in", run_id: runId, surface: "app", body: { text: said } });
    append(sql, { actor: "atlas", kind: "message.out", run_id: runId, surface: "app", body: { text: `reply ${i} ${"y".repeat(size)}` } });
  }
}

/**
 * A brain that acts like Atlas would on each kind of request: it saves the
 * invoice promise on the save pass, writes a summary when asked, and
 * otherwise answers briefly.
 */
function memoryBrain(opts: { summary?: string | Error } = {}): Brain & { requests: BrainRequest[] } {
  const requests: BrainRequest[] = [];
  return {
    provider: "chatgpt",
    model: "fake",
    requests,
    async *stream(req) {
      requests.push(req);
      const last = req.messages[req.messages.length - 1];
      const asked = last && last.role === "user" ? last.content : "";
      let events: BrainEvent[];
      if (asked.includes(SAVE_NOTE) && last?.role === "user") {
        const saved = req.messages.some((m) => m.role === "tool");
        events = saved
          ? [
              { type: "text", text: "done" },
              { type: "done", finish: "stop" },
            ]
          : [
              {
                type: "tool_call",
                call: {
                  id: "s1",
                  name: "remember",
                  input: { type: "commitment", name: "Keyframes invoice", fact: "Max promised to send the Keyframes invoice on Friday." },
                },
              },
              { type: "done", finish: "tool_calls" },
            ];
      } else if (asked.includes(SUMMARY_NOTE)) {
        if (opts.summary instanceof Error) throw opts.summary;
        events = [
          { type: "text", text: opts.summary ?? "Max talked through the week and promised the Keyframes invoice on Friday." },
          { type: "done", finish: "stop" },
        ];
      } else {
        events = [
          { type: "text", text: "ok" },
          { type: "done", finish: "stop" },
        ];
      }
      // The save pass's follow-up after the tool result also ends with the tool message, not the note.
      if (last?.role === "tool")
        events = [
          { type: "text", text: "done" },
          { type: "done", finish: "stop" },
        ];
      for (const e of events) yield e;
    },
  };
}

function deps(sql: Sql, brain: Brain) {
  const toolContext: Omit<ToolContext, "run_id"> = {
    sql,
    settings: readSettings(sql),
    tz: TZ,
    now: new Date(),
    calendar: null,
    clock: { schedule: async () => {}, unschedule: async () => {} },
    embed: fakeEmbedder(),
    source_log_id: null,
    via: "compaction",
  };
  return { sql, router: new BrainRouter(() => brain), chain: [{ provider: "chatgpt" as const, model: "fake" }], toolContext };
}

afterEach(() => {
  seams.makeBrain = null;
  seams.contextWindow = null;
  seams.embed = undefined;
  seams.calendar = undefined;
});

describe("planning", () => {
  it("waits until the context passes 70% of the window", () =>
    withSql((sql) => {
      talk(sql, 10, 400); // about 2,000 tokens of messages
      expect(planCompaction(sql, { window: 4_000, systemTokens: 500 })).toBeNull();
      expect(planCompaction(sql, { window: 3_000, systemTokens: 500 })).not.toBeNull();
    }));

  it("keeps the newest messages, and never cuts between a question and its answer", () =>
    withSql((sql) => {
      talk(sql, 10, 400);
      const plan = planCompaction(sql, { window: 3_000, systemTokens: 500 })!;
      const all = history(sql).length;
      expect(all).toBe(20);
      // Each message is about 103 tokens. Keeping a quarter of the window (750) would let 13 leave,
      // but one pass takes at most 40% of the window (1,200): 11 messages. That splits exchange 5,
      // so its question stays too, and 10 leave; the next pass takes the rest.
      expect(plan.rows.length).toBe(10);
      expect(plan.rows[plan.rows.length - 1]!.kind).toBe("message.out");
      expect(plan.rows[plan.rows.length - 1]!.run_id).toBe(plan.rows[plan.rows.length - 2]!.run_id);
      expect(20 - plan.rows.length).toBeGreaterThanOrEqual(KEEP_MESSAGES);
    }));
});

describe("compacting", () => {
  it("saves what matters, then replaces the old part with a summary", () =>
    withSql(async (sql) => {
      talk(sql, 12, 400, "Remind me I owe Keyframes the invoice on Friday, it's important");
      const brain = memoryBrain();
      const system = systemPrompt({ settings: readSettings(sql), tz: TZ, now: new Date(), surface: "none", sql });
      const plan = planCompaction(sql, { window: 3_000, systemTokens: 500 })!;
      const out = await compact({ sql, loop: deps(sql, brain), system }, plan);

      // The save pass ran on the leaving messages and saved the promise.
      expect(brain.requests[0]!.tools.map((t) => t.name)).toEqual(["remember", "recall"]);
      expect(brain.requests[0]!.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("Keyframes") });
      expect(out.save.state).toBe("replied");
      const saved = sql.exec<{ name: string; source: string }>(`SELECT name, source FROM records`).toArray();
      expect(saved).toMatchObject([{ name: "Keyframes invoice" }]);
      expect(JSON.parse(saved[0]!.source).via).toBe("compaction");

      // The summary is its own log row, and runs now see it instead of the old messages.
      expect(out.summary!.body).toMatchObject({ through_seq: plan.through_seq, messages: plan.rows.length });
      expect(latestSummary(sql)!.text).toContain("Keyframes invoice on Friday");
      const after = systemPrompt({ settings: readSettings(sql), tz: TZ, now: new Date(), surface: "app", sql });
      expect(after).toContain("Earlier in this conversation (your own summary");
      expect(JSON.stringify(history(sql))).not.toContain("Remind me I owe Keyframes");
      expect(history(sql).length).toBeLessThan(24);

      // Both steps are runs with one saved final state each.
      const runs = sql.exec<{ state: string }>(`SELECT state FROM runs WHERE trigger = 'compaction' ORDER BY started_at`).toArray();
      expect(runs.map((r) => r.state)).toEqual(["replied", "replied"]);
    }));

  it("carries the earlier summary into the next one", () =>
    withSql(async (sql) => {
      talk(sql, 12, 400);
      const brain = memoryBrain({ summary: "First summary." });
      const sys = () => systemPrompt({ settings: readSettings(sql), tz: TZ, now: new Date(), surface: "none", sql });
      await compact({ sql, loop: deps(sql, brain), system: sys() }, planCompaction(sql, { window: 3_000, systemTokens: 500 })!);
      talk(sql, 12, 400);
      const second = memoryBrain({ summary: "Second summary." });
      await compact({ sql, loop: deps(sql, second), system: sys() }, planCompaction(sql, { window: 3_000, systemTokens: 500 })!);
      expect(second.requests.at(-1)!.system).toContain("First summary.");
      expect(latestSummary(sql)!.text).toBe("Second summary.");
    }));

  it("leaves the context alone when the summary fails, and says why", () =>
    withSql(async (sql) => {
      talk(sql, 12, 400);
      const system = systemPrompt({ settings: readSettings(sql), tz: TZ, now: new Date(), surface: "none", sql });
      const before = history(sql).length;
      const out = await compact(
        { sql, loop: deps(sql, memoryBrain({ summary: new Error("429 from api.openai.com: usage limit reached") })), system },
        planCompaction(sql, { window: 3_000, systemTokens: 500 })!,
      );
      expect(out.summary).toBeNull();
      expect(latestSummary(sql)).toBeNull();
      expect(history(sql).length).toBe(before);
      const failed = sql
        .exec<{ detail: string }>(`SELECT detail FROM runs WHERE trigger = 'compaction' AND state = 'failed'`)
        .toArray()
        .map((r) => JSON.parse(r.detail).error);
      expect(failed[0]).toContain("usage limit reached");
    }));
});

describe("in the agent", () => {
  it("compacts a long conversation in the background, and the next run still knows the promise", async () => {
    const brain = memoryBrain();
    seams.makeBrain = () => brain;
    seams.contextWindow = 3_000;
    seams.embed = fakeEmbedder();
    seams.calendar = fakeCalendar([]);
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`ca-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      talk(sql, 14, 400, "I owe Keyframes the invoice on Friday");
      await agent.apiSettleCompaction();
      expect(latestSummary(sql)).not.toBeNull();
      // It took more than one pass, and the context is back under the line.
      expect(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE kind = 'context.summary'`).one().n).toBeGreaterThan(1);
      expect(planCompaction(sql, { window: 3_000, systemTokens: 0 })).toBeNull();
      expect(standingFacts(sql)).toEqual([]); // a commitment, not a preference: found by recall

      await agent.apiTurn("what do I owe this week?");
      const asked = brain.requests.at(-1)!;
      expect(asked.system).toContain("promised the Keyframes invoice on Friday");
      expect(asked.messages.some((m) => m.role === "user" && m.content.includes("I owe Keyframes"))).toBe(false);
    });
  });

  it("waits after a failure, across restarts, and keeps it out of the thread", async () => {
    seams.makeBrain = () => memoryBrain({ summary: new Error("429 from api.openai.com: usage limit reached") });
    seams.contextWindow = 3_000;
    seams.embed = fakeEmbedder();
    seams.calendar = fakeCalendar([]);
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`cf-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      talk(sql, 14, 400);
      await agent.apiSettleCompaction();
      expect(latestSummary(sql)).toBeNull();
      expect(getState<number>(sql, "compaction_failed_at")).toBeGreaterThan(0);
      const runs = () => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM runs WHERE trigger = 'compaction'`).one().n;
      const before = runs();
      await agent.apiSettleCompaction();
      expect(runs()).toBe(before); // waiting, not trying again
      expect(sql.exec(`SELECT 1 FROM runs WHERE trigger = 'compaction' AND state = 'failed'`).toArray().length).toBeGreaterThan(0);
      expect(thread(sql, 100).some((r) => r.kind === "run.end" && r.body.trigger === "compaction")).toBe(false);
    });
  });
});

describe("the thread", () => {
  it("pages past rows it doesn't show", () =>
    withSql((sql) => {
      talk(sql, 3, 10);
      // Many rows of thread kinds that the thread doesn't show.
      for (let i = 0; i < 400; i++) append(sql, { actor: "atlas", kind: "tool.result", body: { ok: true } });
      expect(thread(sql, 10).filter((r) => r.kind.startsWith("message.")).length).toBe(6);
    }));
});
