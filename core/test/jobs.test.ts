import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { HelperDesk } from "../src/agent/helpers";
import { BrainRouter } from "../src/brains/router";
import { HelperAgent, type HelperJob } from "../src/helper";
import { createItem, getItem } from "../src/store/agenda";
import type { Sql } from "../src/store/db";
import { migrate } from "../src/store/db";
import { startRun } from "../src/store/runs";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, type Step } from "./helpers";

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

function brain(steps: Step[]) {
  const b = scripted(steps, "chatgpt", "gpt-5.6-terra");
  seams.makeBrain = (c) => (c.provider === "chatgpt" ? b.brain : null);
  return b;
}

const fresh = () => env.PersonAgent.get(env.PersonAgent.idFromName(`j-${crypto.randomUUID()}`));

async function until<T>(fn: () => T | null | undefined, what: string, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const rowsOf = (sql: Sql, kind: string) =>
  sql
    .exec<{ run_id: string | null; body: string }>(`SELECT run_id, body FROM log WHERE kind = ? ORDER BY seq`, kind)
    .toArray()
    .map((r) => ({ run_id: r.run_id, body: JSON.parse(r.body) as Record<string, unknown> }));

describe("helpers", () => {
  it("hand back a result in the same turn, and everything they did is in the parent's log", async () => {
    const b = brain([
      call("delegate", { title: "Riverside notes", task: "Find everything about the Riverside shoot and list it." }),
      call("recall", { query: "Riverside" }),
      say("- Riverside shoot moved to Saturday (you said Oct 18)."),
      say("It moved to Saturday."),
    ]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const out = await agent.apiTurn("what's the latest on Riverside? dig through everything");
      expect(out.reply).toBe("It moved to Saturday.");

      // The owner's run got the helper's result as the tool's output.
      expect(b.requests[3]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("moved to Saturday") });
      // The helper had no personality and only lookup tools.
      expect(b.requests[1]!.system).toContain("You are a helper for Atlas");
      expect(b.requests[1]!.tools.map((t) => t.name).sort()).toEqual(["calendar_read", "recall", "reminder_list"]);

      const result = rowsOf(sql, "job.result")[0]!;
      expect(result.body).toMatchObject({ title: "Riverside notes", state: "done", text: expect.stringContaining("Saturday") });
      const helperRun = result.run_id!;
      expect(
        rowsOf(sql, "tool.call")
          .filter((r) => r.run_id === helperRun)
          .map((r) => r.body.name),
      ).toEqual(["recall"]);
      expect(sql.exec<{ state: string; trigger: string }>(`SELECT state, trigger FROM runs WHERE id = ?`, helperRun).one()).toMatchObject({
        state: "replied",
        trigger: expect.stringMatching(/^job:ag_/),
      });
      const jobs = await agent.apiJobs();
      expect(jobs[0]).toMatchObject({ title: "Riverside notes", state: "done", steps: 1 });
      // Answered in the turn, so it isn't reported a second time.
      expect(rowsOf(sql, "message.out").length).toBe(1);
    });
  });

  it("work in the background and report when they're done", async () => {
    brain([
      call("delegate", { title: "Calendar audit", task: "List every clash in the next month.", wait: false }),
      say("On it; I'll tell you when it's done."),
      say("No clashes found."),
      say("Your helper found no clashes next month."),
    ]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const out = await agent.apiTurn("check my next month for clashes, no rush");
      expect(out.reply).toBe("On it; I'll tell you when it's done.");
      const report = await until(
        () => rowsOf(sql, "message.out").find((r) => String(r.body.trigger ?? "").startsWith("job:")),
        "the job's report",
      );
      expect(report.body.text).toBe("Your helper found no clashes next month.");
    });
  });

  it("pick up from their last checkpoint after a restart", async () => {
    const b = brain([say("Two clashes: Tue 3 PM and Thu 10 AM.")]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const run_id = startRun(sql, { actor: "atlas", trigger: "helper", surface: "none", role: "main" });
      const item = createItem(sql, {
        kind: "job",
        title: "Clashes",
        due_at: Date.now(),
        state: "running",
        source: { via: "chat", detail: { brief: "Find clashes.", helper_run: run_id, tools: ["calendar_read"] } },
      });
      const job: HelperJob = {
        id: item.id,
        run_id,
        system: "You are a helper.",
        brief: "Find clashes.",
        tools: ["calendar_read"],
        chain: [{ provider: "chatgpt", model: "gpt-5.6-terra" }],
        budget: { steps: 10, ms: 60_000 },
      };
      // As if a restart cut the job short after its first lookup.
      const at = {
        steps: 1,
        text: "",
        messages: [
          { role: "user" as const, content: "Find clashes." },
          { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "calendar_read", input: {} }] },
          { role: "tool" as const, callId: "c1", name: "calendar_read", content: '{"events":[]}' },
        ],
      };
      const child = await agent.dynamicAgents.get(HelperAgent, item.id);
      await child.resumeFrom({ job, at });
      await until(() => getItem(sql, item.id)!.state === "done", "the job to finish");
      // It carried on from the checkpoint rather than starting over.
      const helperCalls = b.requests.filter((r) => r.system === "You are a helper.");
      expect(helperCalls.length).toBe(1);
      // Nobody was waiting for it, so the owner is told.
      expect(b.requests[1]!.messages[0]).toMatchObject({ content: expect.stringContaining('The job "Clashes" you started finished') });
      expect(b.requests[0]!.messages.length).toBe(3);
      expect(rowsOf(sql, "job.result")[0]!.body.text).toBe("Two clashes: Tue 3 PM and Thu 10 AM.");
    });
  });

  it("stop when the owner stops them, and the waiting turn hears why", async () => {
    await runInDurableObject(fresh(), async (_agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const aborted: string[] = [];
      const desk = new HelperDesk({
        sql,
        router: new BrainRouter(() => null),
        makeBrain: () => null,
        toolContext: () => ({}) as never,
        launch: async () => {},
        abort: (id) => void aborted.push(id),
        report: async () => {},
        rows: () => {},
        jobsChanged: () => {},
      });
      const job = await desk.start({ title: "Slow one", brief: "x", system: "s", tools: ["recall"], chain: [], askedIn: "" });
      const waiting = desk.wait(job.id, 5_000);
      expect(desk.stop(job.id)).toBe(true);
      expect(await waiting).toMatchObject({ state: "cancelled", error: "Stopped by the owner." });
      expect(aborted).toEqual([job.id]);
      expect(getItem(sql, job.id)!.state).toBe("cancelled");
      expect(desk.stop(job.id)).toBe(false);
    });
  });

  it("refuse tools they weren't given", async () => {
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const run_id = startRun(sql, { actor: "atlas", trigger: "helper", surface: "none", role: "main" });
      const item = createItem(sql, {
        kind: "job",
        title: "Slow one",
        due_at: Date.now(),
        state: "running",
        source: { via: "chat", detail: { brief: "x", helper_run: run_id, tools: ["recall"] } },
      });
      expect(await agent.helperTool(item.id, "calendar_read", {})).toEqual({
        ok: false,
        output: { error: "This helper can't use calendar_read." },
      });
      expect(await agent.helperTool(item.id, "remember", {})).toMatchObject({ ok: false });
      await agent.dynamicAgents.get(HelperAgent, item.id);
      const ws = await agent.apiJobs();
      expect(ws[0]).toMatchObject({ state: "running" });
    });
  });
});
