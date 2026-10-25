import { describe, expect, it } from "vitest";
import { anthropicBrain, readMessagesStream, refusal, regainsAt, toSystem, toTurns } from "../src/brains/anthropic";
import {
  catalogPrice,
  costOf,
  dayOf,
  dollars,
  monthOf,
  NEURON_USD,
  nextMonthUtc,
  priceOf,
  type Spend,
  workersAIModels,
} from "../src/brains/catalog";
import { chatgptBrain, planLimits } from "../src/brains/chatgpt";
import { BrainRouter } from "../src/brains/router";
import { BrainError } from "../src/brains/types";
import { workersAIBrain, workersAIError } from "../src/brains/workers-ai";
import { chainFor, Settings } from "../src/store/settings";
import { collect, sse } from "./helpers";

describe("Anthropic as a brain (§18)", () => {
  it("reads text, a tool call built from its pieces, and usage with the cached part", async () => {
    const events = await collect(
      readMessagesStream(
        sse([
          { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "your week." } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "calendar_read" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"start":"2026-' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '10-22"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
          { type: "message_stop" },
        ]),
      ),
    );
    expect(events).toEqual([
      { type: "text", text: "Checking " },
      { type: "text", text: "your week." },
      { type: "tool_start", name: "calendar_read" },
      { type: "tool_call", call: { id: "toolu_1", name: "calendar_read", input: { start: "2026-10-22" } } },
      { type: "done", finish: "tool_calls", usage: { input: 950, output: 30, cached: 900 } },
    ]);
  });

  it("keeps the stable part of the prompt cached, and puts tool results in the next user turn", () => {
    expect(toSystem("character and portrait\n\n---\n\nnow and the situation")).toEqual([
      { type: "text", text: "character and portrait", cache_control: { type: "ephemeral" } },
      { type: "text", text: "now and the situation" },
    ]);
    expect(
      toTurns([
        { role: "assistant", content: "stray greeting" },
        { role: "user", content: "what's on Thursday?" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "calendar_read", input: { day: "thu" } }] },
        { role: "tool", callId: "t1", name: "calendar_read", content: "dentist at 10" },
        { role: "user", content: "and Friday?" },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "what's on Thursday?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calendar_read", input: { day: "thu" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "dentist at 10" },
          { type: "text", text: "and Friday?" },
        ],
      },
    ]);
  });

  it("says why a request was refused in Anthropic's own words, and whether trying again can help", async () => {
    const bad = await refusal(
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
        status: 401,
      }),
    );
    expect(bad).toBeInstanceOf(BrainError);
    expect(bad.message).toContain("invalid x-api-key");
    expect(bad.permanent).toBe(true);
    const busy = await refusal(
      new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 }),
    );
    expect(busy.permanent).toBe(false);
    expect(busy.message).toMatch(/HTTP 529.*Overloaded/);
  });

  it("sends the key in its header, the model, the cached system and tools, and never runs without a key", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(sse([{ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "message_stop" }]), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const brain = anthropicBrain(() => "sk-ant-test-key", "claude-sonnet-5-5", f);
    await collect(
      brain.stream({
        system: "stable\n\n---\n\nfresh",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "recall", description: "Remember", parameters: { type: "object", properties: {} } }],
      }),
    );
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(sent[0]!.body).toMatchObject({
      model: "claude-sonnet-5-5",
      stream: true,
      tools: [{ name: "recall", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    });
    const none = anthropicBrain(() => null, "claude-sonnet-5-5", f);
    await expect(collect(none.stream({ system: "", messages: [], tools: [] }))).rejects.toThrow(/no API key/);
  });
});

describe("named brains (§18)", () => {
  const settings = Settings.parse({
    named_brains: {
      brains: [
        {
          name: "Quick",
          line: "Fast and cheap, for routine work.",
          chain: [{ provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" }],
        },
        { name: "Deep", line: "Careful thinking.", chain: [{ provider: "anthropic", model: "claude-opus-5-5" }] },
      ],
      uses: { helpers: "Quick", research: "Deep" },
    },
  });

  it("gives each kind of work its brain, the one asked for by name, or the main chain, and refuses a name that isn't there", () => {
    expect(chainFor(settings, "helpers").name).toBe("Quick");
    expect(chainFor(settings, "research").chain).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
    expect(chainFor(settings, "skill_review")).toEqual({ name: "Main", chain: settings.brains.main });
    expect(chainFor(settings, "helpers", "deep").name).toBe("Deep");
    expect(() => chainFor(settings, "helpers", "GPT-9")).toThrow('There\'s no brain called "GPT-9". The brains are: Quick, Deep.');
  });

  it("keeps working with settings saved before named brains", () => {
    const old = Settings.parse({ brains: settings.brains });
    expect(old.named_brains).toEqual({
      brains: [],
      uses: { helpers: null, research: null, job_work: null, job_looks: null, skill_review: null },
    });
    expect(chainFor(old, "helpers").name).toBe("Main");
  });
});

describe("what brains cost, how fast they are, and what they have left (§18)", () => {
  const sonnet = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  const kimi = { provider: "workers-ai" as const, model: "@cf/moonshotai/kimi-k2.6" };

  it("prices a model from the dated table, a dated id like its model, and nothing it doesn't know", () => {
    expect(priceOf(sonnet)).toMatchObject({ in: 2, out: 10, cached: 0.1, written: 2.5 });
    expect(priceOf({ provider: "anthropic", model: "claude-opus-4-5-20251101" })).toMatchObject({ in: 5, out: 25 });
    expect(priceOf({ provider: "anthropic", model: "claude-opus-5" })).toMatchObject({ in: 5 });
    expect(priceOf(kimi)).toMatchObject({ in: 0.95, out: 4, paid_plan: true });
    expect(priceOf({ provider: "chatgpt", model: "gpt-5.6-terra" })).toBeNull();
    expect(priceOf({ provider: "anthropic", model: "claude-next-9" })).toBeNull();
    // 1M plain input at $2, 1M read from the cache at $0.10, 1M written at $2.50, 1M out at $10.
    expect(costOf(sonnet, { input: 3_000_000, cached: 1_000_000, written: 1_000_000, output: 1_000_000 })).toBeCloseTo(14.6);
    expect(dollars(0.004)).toBe("under a cent");
    expect(dollars(18.4)).toBe("$18");
  });

  it("reads Workers AI's catalog through the binding: text models that take tools, with the catalog's own price", async () => {
    expect(catalogPrice("$0.95 per M input tokens, $4.00 per M output tokens, $0.16 per M cached input tokens")).toEqual({
      in: 0.95,
      out: 4,
      cached: 0.16,
    });
    expect(
      catalogPrice([
        { unit: "per M input tokens", price: 0.6, currency: "USD" },
        { unit: "per M output tokens", price: 3, currency: "USD" },
      ]),
    ).toEqual({ in: 0.6, out: 3 });
    const asked: unknown[] = [];
    const ai = {
      models: async (p: unknown) => {
        asked.push(p);
        return [
          {
            name: "@cf/moonshotai/kimi-k2.6",
            task: { name: "Text Generation" },
            properties: [
              { property_id: "function_calling", value: "true" },
              { property_id: "context_window", value: "262144" },
              {
                property_id: "price",
                value: [
                  { unit: "per M input tokens", price: 0.95 },
                  { unit: "per M output tokens", price: 4 },
                ],
              },
            ],
          },
          {
            name: "@cf/moonshotai/kimi-k2.5",
            task: { name: "Text Generation" },
            properties: [{ property_id: "function_calling", value: true }],
          },
          { name: "@cf/meta/llama-2-7b-chat-fp16", task: { name: "Text Generation" }, properties: [] },
          { name: "@cf/baai/bge-m3", task: { name: "Text Embeddings" }, properties: [{ property_id: "function_calling", value: "true" }] },
        ];
      },
    };
    const models = await workersAIModels(ai);
    expect(asked[0]).toMatchObject({ task: "Text Generation" });
    expect(models).toEqual([
      { id: "@cf/moonshotai/kimi-k2.5", name: "kimi-k2.5", price: { in: 0.6, cached: 0.1, out: 3 } },
      { id: "@cf/moonshotai/kimi-k2.6", name: "kimi-k2.6", price: { in: 0.95, out: 4, paid_plan: true }, context: 262144 },
    ]);
  });

  it("measures each brain's speed, counts what paid brains cost this month, and Workers AI's neurons today", () => {
    let saved: Spend | null = null;
    const router = new BrainRouter(
      () => null,
      { load: () => null, save: () => {}, loadSpend: () => saved, saveSpend: (s) => (saved = s) },
      () => 20,
    );
    router.markOk(sonnet, { first_ms: 800, total_ms: 2_800, usage: { input: 10_000, cached: 8_000, output: 200 } });
    router.markOk(sonnet, { first_ms: 1_200, total_ms: 3_200, usage: { input: 10_000, cached: 8_000, output: 200 } });
    expect(router.snapshot()["anthropic:claude-sonnet-5-5"]!.speed).toEqual({ first_ms: 1_000, tps: 100, runs: 2 });
    router.markOk(kimi, { first_ms: 300, total_ms: 400, usage: { input: 100_000, output: 1_000 } });
    const spend = router.spend();
    // Two calls of 2,000 plain input, 8,000 cached and 200 out on Sonnet.
    expect(spend.paid).toBeCloseTo((2 * (2_000 * 2 + 8_000 * 0.1 + 200 * 10)) / 1e6);
    expect(spend.neurons).toBeCloseTo((100_000 * 0.95 + 1_000 * 4) / 1e6 / NEURON_USD);
    expect(spend.cap).toBe(20);
    expect(saved).toMatchObject({ month: new Date().toISOString().slice(0, 7) });
  });

  it("holds paid brains to the month's cap, refusing in words with when it starts again, behind the next brain", async () => {
    const now = Date.now();
    const spent: Spend = { month: monthOf(now), usd: { "anthropic:claude-sonnet-5-5": 20.5 }, day: dayOf(now), neurons: 0 };
    const make = (c: { provider: string; model: string }) => ({ ...c, async *stream() {} }) as never;
    const router = new BrainRouter(make, { load: () => null, save: () => {}, loadSpend: () => spent }, () => 20);
    const chain = router.chain([sonnet, kimi]);
    expect(chain.map((b) => b.provider)).toEqual(["workers-ai", "anthropic"]);
    const err = (await collect(chain[1]!.stream({ system: "", messages: [], tools: [] })).catch((e: unknown) => e)) as BrainError;
    expect(err).toBeInstanceOf(BrainError);
    expect(err.message).toMatch(/spending cap for paid brains \(\$20\) is reached: \$21 so far/);
    expect(err.status).toBe(429);
    expect(err.resetAt).toBe(nextMonthUtc(now));
    // With no cap, nothing's held.
    const free = new BrainRouter(make, { load: () => null, save: () => {}, loadSpend: () => spent });
    expect(free.chain([sonnet, kimi])[0]!.provider).toBe("anthropic");
  });

  it("keeps a brain that ran out back until the time its provider gave, and says when a chain is usable again", () => {
    const router = new BrainRouter(() => null);
    const at = Date.now() + 3 * 3600_000;
    const h = router.markFailed(sonnet, new BrainError("Anthropic (HTTP 429): usage limits", false, 429, at));
    expect(h).toMatchObject({ ok: false, until: at, resets_at: at });
    router.markFailed(kimi, new BrainError("Workers AI: down", false, 503));
    expect(router.resetOf([kimi, sonnet])).toBe(at);
    expect(router.resetOf([kimi])).toBeNull();
  });

  it("goes through the owner's AI Gateway with the same body, the gateway's token, and the gateway's words when it refuses", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    let refuse = false;
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      if (refuse) return Response.json({ success: false, result: [], error: [{ code: 2009, message: "Unauthorized" }] }, { status: 401 });
      return new Response(
        sse([
          { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 4000 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "recall" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const via = async () => ({
      url: "https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/anthropic",
      token: "cf-token-for-the-gateway",
    });
    const brain = anthropicBrain(() => "sk-ant-test-key", "claude-sonnet-5-5", f, via);
    const events = await collect(
      brain.stream({
        system: "stable\n\n---\n\nfresh",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "recall", description: "Remember", parameters: { type: "object", properties: {} } }],
      }),
    );
    expect(sent[0]!.url).toBe("https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/anthropic/v1/messages");
    expect(sent[0]!.headers).toMatchObject({
      "x-api-key": "sk-ant-test-key",
      "anthropic-version": "2023-06-01",
      "cf-aig-authorization": "Bearer cf-token-for-the-gateway",
    });
    expect(sent[0]!.body).toMatchObject({
      stream: true,
      system: [{ text: "stable", cache_control: { type: "ephemeral" } }, { text: "fresh" }],
      tools: [{ name: "recall", cache_control: { type: "ephemeral" } }],
    });
    expect(events).toContainEqual({ type: "tool_call", call: { id: "toolu_1", name: "recall", input: { q: "x" } } });
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { input: 4010, cached: 4000 } });
    refuse = true;
    const err = (await collect(brain.stream({ system: "", messages: [], tools: [] })).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(
      "Anthropic through AI Gateway (gateway.ai.cloudflare.com, HTTP 401): the gateway said: Unauthorized (code 2009). If it's an authenticated gateway, check its token in Settings → Brains",
    );
  });

  it("tells a limit from a refusal: retry-after, the monthly cap's date, and the owner's own limit in the Console", async () => {
    const limited = await refusal(
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many requests" } }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.resetAt! - Date.now()).toBeGreaterThan(28_000);
    const capped = await refusal(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message:
              "You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-11-01 at 00:00 UTC.",
          },
        }),
        { status: 429 },
      ),
    );
    expect(capped).toMatchObject({ status: 429, permanent: false, resetAt: Date.parse("2026-11-01T00:00:00Z") });
    const own = await refusal(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
          },
        }),
        { status: 400 },
      ),
    );
    expect(own).toMatchObject({ status: 429, permanent: false });
    expect(own.message).toMatch(/API usage limit is reached/);
    expect(regainsAt("no date here")).toBeUndefined();
  });

  it("reads the ChatGPT plan's windows from its headers, carries them on the answer, and when a used-up plan resets", async () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const h = new Headers({
      "x-codex-primary-used-percent": "62.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(reset),
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-window-minutes": "10080",
    });
    expect(planLimits(h, 1)).toEqual({
      windows: [
        { name: "primary", used_percent: 62.5, window_minutes: 300, resets_at: reset * 1000 },
        { name: "secondary", used_percent: 12, window_minutes: 10080 },
      ],
      seen_at: 1,
    });
    expect(planLimits(new Headers())).toBeNull();
    let full = false;
    const f = (async () =>
      full
        ? Response.json(
            { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached." } },
            { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(reset) } },
          )
        : new Response(
            sse([
              { type: "response.output_text.delta", delta: "Hi." },
              { type: "response.completed", response: {} },
            ]),
            {
              status: 200,
              headers: h,
            },
          )) as unknown as typeof fetch;
    const brain = chatgptBrain({ access: async () => "token" }, "gpt-5.6-terra", f);
    const events = await collect(brain.stream({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(events.at(-1)).toMatchObject({ type: "done", limits: { windows: [{ used_percent: 62.5 }, { used_percent: 12 }] } });
    full = true;
    const err = (await collect(brain.stream({ system: "", messages: [], tools: [] })).catch((e: unknown) => e)) as BrainError;
    expect(err).toMatchObject({ status: 429, permanent: false, resetAt: reset * 1000 });
    expect(err.message).toMatch(/limit for Atlas is used up/);
  });

  it("sends Workers AI through the gateway by the binding's option, and knows its free allowance running out", async () => {
    const got: unknown[] = [];
    const ai = {
      run: async (_m: string, _i: unknown, o: unknown) => {
        got.push(o);
        return { response: "Hi." };
      },
    };
    await collect(workersAIBrain(ai, kimi.model, () => "my-gateway").stream({ system: "", messages: [], tools: [] }));
    expect(got[0]).toMatchObject({ gateway: { id: "my-gateway" } });
    await collect(workersAIBrain(ai, kimi.model).stream({ system: "", messages: [], tools: [] }));
    expect(got[1]).not.toHaveProperty("gateway");
    const now = Date.UTC(2026, 9, 25, 15, 0);
    const out = workersAIError(
      kimi.model,
      "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan",
      now,
    );
    expect(out).toMatchObject({ permanent: false, status: 429, resetAt: Date.UTC(2026, 9, 26) });
    expect(workersAIError(kimi.model, "5018: This model requires a paid plan.").permanent).toBe(true);
  });
});
