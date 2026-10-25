// M7's stage 4 (brains), smoke steps 12 to 14, end to end through Atlas with
// fake providers: an Anthropic key tested live and its catalog with prices,
// a conversation on Anthropic whose second turn reads the cache, named
// brains for helpers and research, and a job whose brain runs out partway
// pausing with when it resets and what going on would cost.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { getGoal } from "../src/agent/goals";
import type { Spend } from "../src/brains/catalog";
import type { Health } from "../src/brains/router";
import { type Brain, BrainError } from "../src/brains/types";
import { getItem } from "../src/store/agenda";
import { migrate, type Sql } from "../src/store/db";
import { setSecret, writeSettings } from "../src/store/settings";
import { getState } from "../src/store/state";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, sse } from "./helpers";
import { connect, inOwner, turn } from "./owner";

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.makeBrain = null;
  seams.fetch = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.workspace = undefined;
});

const fresh = () => env.PersonAgent.get(env.PersonAgent.idFromName(`s4-${crypto.randomUUID()}`));

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Anthropic's Messages API and its models, faked: each answer says what it read from the cache. */
function fakeAnthropic() {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  seams.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      return Response.json({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1_000_000 }] });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      sent.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      const again = sent.length > 2;
      return new Response(
        sse([
          {
            type: "message_start",
            message: {
              usage: { input_tokens: 40, cache_read_input_tokens: again ? 3_000 : 0, cache_creation_input_tokens: again ? 0 : 3_000 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Claude." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
          { type: "message_stop" },
        ]),
        { status: 200 },
      );
    }
    return new Response("not faked", { status: 404 });
  }) as typeof fetch;
  return sent;
}

describe("stage 4: brains, end to end", () => {
  it("smoke 12: takes an Anthropic key, tests it live, lists its models with their cost, and a second turn reads the cache", async () => {
    const sent = fakeAnthropic();
    const s = await connect();
    s.send({ type: "atlas.secret.set", secret: { name: "anthropic_api_key", value: "sk-ant-test-key-not-real-123" } });
    await s.next("atlas.view", (m) => m.view.secrets.anthropic_api_key);
    const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5" };
    s.send({ type: "atlas.settings.update", patch: { brains: { main: [sonnet], voice: [sonnet] } } });
    await s.next("atlas.view", (m) => m.view.settings.brains.main[0]!.provider === "anthropic");

    s.send({ type: "atlas.test", what: "brain", choice: sonnet, ref: "t1" });
    const tested = await s.next("atlas.test.result", (m) => m.ref === "t1");
    expect(tested).toMatchObject({ ok: true, message: expect.stringContaining("anthropic:claude-sonnet-5-5 answered") });
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test-key-not-real-123");

    s.send({ type: "atlas.brain.models", provider: "anthropic" });
    const models = await s.next("atlas.brain.models", (m) => m.provider === "anthropic");
    expect(models.models).toEqual([
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        price: { in: 2, written: 2.5, cached: 0.1, out: 10 },
        context: 1_000_000,
      },
    ]);

    await turn(s, "hello");
    const second = await turn(s, "and again");
    // The stable part of the prompt and the tools went marked for the cache, and the second turn read them from it.
    // What's true now rides with the turn's message, so the whole prompt is the stable part (§4.1); the conversation
    // so far is cached up to its last block.
    expect(sent.at(-1)!.body).toMatchObject({ system: [{ cache_control: { type: "ephemeral" } }] });
    const turns = (sent.at(-1)!.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }).messages;
    expect(turns.at(-1)!.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    const end = await inOwner((_a, sql) =>
      sql.exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'run.end' AND run_id = ?`, second.run).one(),
    );
    expect(JSON.parse(end.body)).toMatchObject({ usage: { cached: 3_000 } });

    // What it cost, and how fast it was, as Brains shows them.
    const { spend, health } = await inOwner((_a, sql) => ({
      spend: getState<Spend>(sql, "brain_spend"),
      health: getState<Record<string, Health>>(sql, "brain_health"),
    }));
    expect(spend!.usd["anthropic:claude-sonnet-5-5"]).toBeGreaterThan(0);
    expect(health!["anthropic:claude-sonnet-5-5"]!.speed).toMatchObject({ runs: expect.any(Number) });
    s.send({ type: "atlas.settings.update", patch: { spending: { cap: 50 } } });
    const view = await s.next("atlas.view", (m) => m.view.settings.spending.cap === 50);
    expect(view.view.brains.spend).toMatchObject({ cap: 50, paid: spend!.usd["anthropic:claude-sonnet-5-5"] });
    expect(view.view.brains.prices["anthropic:claude-sonnet-5-5"]).toMatchObject({ in: 2, out: 10 });
  });

  it("smoke 13: helpers start on Quick and research on Deep, by the owner's defaults, and each job shows its brain", async () => {
    const main = scripted(
      [
        call("delegate", { title: "Laptops", task: "Compare these five laptops.", wait: true }),
        say("The ThinkPad wins."),
        call("delegate", { title: "Sync research", task: "Research the best way to sync SQLite.", research: true }),
        say("I've started the research."),
      ],
      "chatgpt",
      "gpt-5.6-terra",
    );
    const quick = scripted([say("ThinkPad X1: best keyboard and battery.")], "workers-ai", "quick-model");
    const deep = scripted([say("Use CRDT-based sync, with sources.")], "anthropic", "deep-model");
    seams.makeBrain = (c) => (c.model === "quick-model" ? quick.brain : c.model === "deep-model" ? deep.brain : main.brain);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      writeSettings(sql, {
        named_brains: {
          brains: [
            { name: "Quick", line: "Fast and cheap, for routine work.", chain: [{ provider: "workers-ai", model: "quick-model" }] },
            { name: "Deep", line: "Careful thinking, for hard problems.", chain: [{ provider: "anthropic", model: "deep-model" }] },
          ],
          uses: { helpers: "Quick", research: "Deep", job_work: null, job_looks: "Deep", skill_review: null },
        },
      });
      const out = await agent.apiTurn("compare these five laptops");
      expect(out.reply).toBe("The ThinkPad wins.");
      expect(quick.requests).toHaveLength(1);
      // Atlas sees the names and lines, never a vendor or a model.
      expect(main.requests[0]!.system).toContain("- Quick: Fast and cheap, for routine work.");
      expect(main.requests[0]!.system).not.toContain("quick-model");

      await agent.apiTurn("research the best way to sync SQLite; take your time");
      await until(() => deep.requests.length > 0, "the research on Deep");
      const brains = sql
        .exec<{ title: string; source: string }>(`SELECT title, source FROM agenda WHERE kind = 'job' ORDER BY created_at`)
        .toArray()
        .map((r) => [r.title, (JSON.parse(r.source) as { detail?: { brain?: string } }).detail?.brain]);
      expect(brains).toEqual([
        ["Laptops", "Quick"],
        ["Sync research", "Deep"],
      ]);
    });
  });

  it(
    "smoke 14: a job whose plan runs out partway pauses at a clean step, with when it resets and what Deep would cost so far",
    { timeout: 30_000 },
    async () => {
      const reset = Date.now() + 3 * 3600_000;
      const used = (input: number, output: number) => ({ type: "done" as const, finish: "stop" as const, usage: { input, output } });
      const ask = scripted([
        call("job_own", {
          title: "Launch video",
          goal: "A 60-second launch video.",
          steps: [
            { title: "Write the script", kind: "work" },
            { title: "Approve the script", kind: "checkpoint" },
          ],
        }),
        say("I've started the launch video."),
      ]);
      // The first look: one move, on the main brain, which counts its tokens to the job.
      const look = scripted([
        [
          { type: "tool_start", name: "job_step" },
          { type: "tool_call", call: { id: "c1", name: "job_step", input: { step: "s1", brief: "Write a 60-second script." } } },
          { type: "done", finish: "tool_calls", usage: { input: 200_000, output: 10_000 } },
        ],
        [{ type: "text", text: "The script is being written." }, used(20_000, 500)],
      ]);
      // All on the main brain: the owner's turn, the job's looks, and the step's helper, which finds the plan's limit
      // used up, with when it resets. Atlas's own background runs get a quiet answer.
      const plan: Brain = {
        provider: "chatgpt",
        model: "gpt-5.6-terra",
        async *stream(req) {
          if (req.system.includes("You are a helper"))
            throw new BrainError("Your ChatGPT plan's limit for Atlas is used up for now.", false, 429, reset);
          if (req.tools.some((t) => t.name === "job_step")) yield* look.brain.stream(req);
          else if (JSON.stringify(req.messages).includes("make a 60-second launch video")) yield* ask.brain.stream(req);
          else yield* say("Nothing to add.");
        },
      };
      const deep = scripted([], "anthropic", "claude-opus-5-5");
      seams.makeBrain = (c) => (c.provider === "anthropic" ? deep.brain : c.provider === "chatgpt" ? plan : null);
      // A workspace that makes the job's folder and nothing else.
      seams.workspace = {
        run: async () =>
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: { exit: 0, ms: 1, blocked: [], kept: "" } })}\n`));
              c.close();
            },
          }),
        read: async () => ({ ok: false, error: "none" }),
        list: async () => [],
        preview: async () => ({ token: "", expires: 0 }),
        status: async () => ({ running: true, ready: true }),
        restart: async () => {},
      };
      await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
        const sql: Sql = state.storage.sql;
        migrate(sql);
        setSecret(sql, "anthropic_api_key", "sk-ant-test-key-not-real-123");
        writeSettings(sql, {
          timezone: "UTC",
          named_brains: {
            brains: [{ name: "Deep", line: "Careful thinking.", chain: [{ provider: "anthropic", model: "claude-opus-5-5" }] }],
            uses: { helpers: null, research: null, job_work: null, job_looks: null, skill_review: null },
          },
        });
        await agent.apiTurn("make a 60-second launch video for Atlas");
        const id = (
          await until(() => sql.exec<{ key: string }>(`SELECT key FROM state WHERE key LIKE 'goal:%'`).toArray()[0], "the job")
        ).key.slice(5);
        expect(getItem(sql, id)?.kind).toBe("job");
        // Its first look is on the clock now (the job watches itself), then the step goes to a helper.
        const paused = await until(
          () => {
            const g = getGoal(sql, id);
            return g?.phase === "paused" && g.question ? g : null;
          },
          "the pause",
          15_000,
        );
        // The router heard when the plan resets, and the pause offers that time; Deep's price for the tokens so far.
        const at = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(reset));
        const sameDay = new Date(reset).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
        expect(paused.question!.options[0]).toEqual(sameDay ? `Wait until ${at}` : expect.stringContaining("Wait until"));
        // 220,000 in at $4 and 10,500 out at $20 a million on Claude Opus 5.5.
        expect(paused.question!.options[1]).toBe("Go on with Deep (about $1.09 for the job so far)");
        expect(paused.question!.text).toContain("It resets");
        expect(paused.plan[0]).toMatchObject({ id: "s1", state: "todo" });
        // Unanswered, nothing runs.
        await agent.onAgendaDue({ id });
        expect(deep.requests).toHaveLength(0);
        expect(getGoal(sql, id)!.phase).toBe("paused");
      });
    },
  );
});
