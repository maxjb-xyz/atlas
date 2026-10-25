// Fast, natural talk (§4.1, decided 2026-10-25): an owner's turn reads the recent conversation and the
// summary before it, starts with the common tools and an index of the rest, keeps what's true now with its
// message so the prompt before it caches, thinks briefly, and asks the provider for the same cache each turn.

import { afterEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { chatgptBrain, chatgptCacheKey } from "../src/brains/chatgpt";
import type { BrainEvent } from "../src/brains/types";
import { tokens } from "../src/context";
import { append } from "../src/store/log";
import { say } from "./helpers";
import { brain, connect, inOwner, turn } from "./owner";

afterEach(() => {
  seams.makeBrain = null;
});

describe("an owner's turn", () => {
  it("reads the recent conversation, starts with the common tools, and carries what's true now with its message", async () => {
    // A long conversation before: far more than a turn reads.
    await inOwner((_a, sql) => {
      for (let i = 0; i < 60; i++)
        append(sql, {
          actor: i % 2 ? "atlas" : "owner",
          kind: i % 2 ? "message.out" : "message.in",
          surface: "app",
          body: { text: `${i}: ${"a long line about the launch video and its music ".repeat(40)}` },
        });
    });
    const s = await connect();
    const b = brain([say("Hey.")]);
    await turn(s, "hey");
    const req = b.requests[0]!;
    // The common tools and the index; the rest (like show) load by name.
    const names = req.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["recall", "calendar_read", "web_search", "tools_load"]));
    expect(names).not.toContain("show");
    expect(names).not.toContain("automation_save");
    expect(req.tools.find((t) => t.name === "tools_load")!.description).toContain("stage: show:");
    // The history it reads stays near the turn's budget, however long the conversation.
    const read = req.messages.reduce((n, m) => n + tokens(String(m.content)), 0);
    expect(read).toBeLessThan(12_000);
    // What's true now rides with the owner's message, not in the prompt, so the prompt caches from turn to turn.
    const last = String(req.messages.at(-1)!.content);
    expect(last).toMatch(/^<now>\nWhat's true right now, from Atlas's own context, not from the owner:\n\nNow: /);
    expect(last.endsWith("hey")).toBe(true);
    expect(req.effort).toBe("low");
    expect(req.cacheKey).toBe("atlas:owner:owner:main");
  });
});

describe("ChatGPT's cache key", () => {
  const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const ok = () =>
    new Response(
      sse([
        { type: "response.output_text.delta", delta: "Hi." },
        { type: "response.completed", response: {} },
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
    const out: BrainEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it("marks explicit cache breakpoints on the last two of the owner's messages, and drops them if refused", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let refuse = false;
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (refuse && "prompt_cache_options" in body)
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'prompt_cache_options'." } }), { status: 400 });
      return ok();
    }) as unknown as typeof fetch;
    chatgptCacheKey.refused = false;
    chatgptCacheKey.breakpoints = true;
    const b = chatgptBrain({ access: async () => "token" }, "gpt-5.6-terra", f);
    const req = {
      system: "",
      messages: [
        { role: "user" as const, content: "one" },
        { role: "assistant" as const, content: "1" },
        { role: "user" as const, content: "two" },
        { role: "assistant" as const, content: "2" },
        { role: "user" as const, content: "three" },
      ],
      tools: [],
      cacheKey: "atlas:owner:owner:main",
    };
    await collect(b.stream(req));
    const input = bodies[0]!.input as Array<{ content?: Array<{ text: string; prompt_cache_breakpoint?: unknown }> }>;
    const marked = input
      .flatMap((i) => i.content ?? [])
      .filter((c) => c.prompt_cache_breakpoint)
      .map((c) => c.text);
    expect(marked).toEqual(["two", "three"]);
    expect(bodies[0]!.prompt_cache_options).toEqual({ mode: "explicit" });
    // Refused: dropped for good, and the turn still answers.
    refuse = true;
    expect((await collect(b.stream(req))).at(-1)).toMatchObject({ type: "done" });
    expect(chatgptCacheKey.breakpoints).toBe(false);
    expect(bodies.at(-1)!.prompt_cache_options).toBeUndefined();
    chatgptCacheKey.breakpoints = true;
  });

  it("is sent with each turn, and dropped for good if the endpoint says it doesn't take one", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let refuse = true;
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (refuse && "prompt_cache_key" in body)
        return new Response(JSON.stringify({ detail: "Unsupported parameter: prompt_cache_key" }), { status: 400 });
      return ok();
    }) as unknown as typeof fetch;
    chatgptCacheKey.refused = false;
    chatgptCacheKey.breakpoints = false;
    const b = chatgptBrain({ access: async () => "token" }, "gpt-5.6-terra", f);
    const req = { system: "", messages: [{ role: "user" as const, content: "hi" }], tools: [], cacheKey: "atlas:owner:owner:main" };
    expect((await collect(b.stream(req))).at(-1)).toMatchObject({ type: "done" });
    expect(bodies.map((x) => x.prompt_cache_key)).toEqual(["atlas:owner:owner:main", undefined]);
    await collect(b.stream(req));
    expect(bodies.at(-1)!.prompt_cache_key).toBeUndefined();

    // An endpoint that takes it gets it every time.
    // It's remembered for every brain until the Worker restarts; a fresh start sends it again.
    expect(chatgptCacheKey.refused).toBe(true);
    chatgptCacheKey.refused = false;
    refuse = false;
    const c = chatgptBrain({ access: async () => "token" }, "gpt-5.6-terra", f);
    await collect(c.stream(req));
    expect(bodies.at(-1)!.prompt_cache_key).toBe("atlas:owner:owner:main");
    chatgptCacheKey.breakpoints = true;
  });
});
