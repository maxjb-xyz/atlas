import { describe, expect, it } from "vitest";
import { anthropicBrain, readMessagesStream, refusal, toSystem, toTurns } from "../src/brains/anthropic";
import { BrainError } from "../src/brains/types";
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
