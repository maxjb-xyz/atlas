import { describe, expect, it } from "vitest";
import { readCodexStream, refusal, toInput } from "../src/brains/codex";
import { jwtClaims, pollDeviceLogin, startDeviceLogin, toTokens } from "../src/brains/codex-auth";
import { BrainRouter } from "../src/brains/router";
import { BrainError } from "../src/brains/types";
import { readWorkersAIStream, toChatMessages } from "../src/brains/workers-ai";
import { scrub, StreamScrubber } from "../src/outbox";
import { isoLocal, parseWhen, shortLocal, startOfLocalDay, addLocalDays } from "../src/time";
import { checkSession, makeSession } from "../src/auth";
import { collect, scripted, sse } from "./helpers";

describe("time", () => {
  const ny = "America/New_York";

  it("reads wall-clock times in the owner's zone", () => {
    expect(parseWhen("2026-10-22T10:00", ny)!.toISOString()).toBe("2026-10-22T14:00:00.000Z");
    expect(parseWhen("2026-12-22T10:00", ny)!.toISOString()).toBe("2026-12-22T15:00:00.000Z");
    expect(parseWhen("2026-10-22", ny)!.toISOString()).toBe("2026-10-22T04:00:00.000Z");
  });

  it("keeps explicit offsets", () => {
    expect(parseWhen("2026-10-22T10:00:00Z", ny)!.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect(parseWhen("2026-10-22T10:00:00+02:00", ny)!.toISOString()).toBe("2026-10-22T08:00:00.000Z");
  });

  it("rejects nonsense", () => {
    expect(parseWhen("tomorrow at 10", ny)).toBeNull();
    expect(parseWhen("2026-13-01", ny)).toBeNull();
  });

  it("moves through a DST gap like a clock does", () => {
    // 2:30 AM doesn't exist on Mar 8, 2026 in New York.
    expect(parseWhen("2026-03-08T02:30", ny)!.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("formats with the offset in force", () => {
    expect(isoLocal(new Date("2026-10-22T14:00:00Z"), ny)).toBe("2026-10-22T10:00:00-04:00");
    expect(isoLocal(new Date("2026-12-22T15:00:00Z"), ny)).toBe("2026-12-22T10:00:00-05:00");
    expect(isoLocal(new Date("2026-10-22T14:00:00Z"), "Asia/Kolkata")).toBe("2026-10-22T19:30:00+05:30");
    expect(shortLocal(new Date("2026-10-22T14:00:00Z"), ny)).toContain("10:00");
  });

  it("counts local days across a DST change", () => {
    const start = startOfLocalDay(new Date("2026-11-01T12:00:00Z"), ny);
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(addLocalDays(start, 1, ny).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("codex brain", () => {
  it("reads text, tool calls and usage from the Responses stream", async () => {
    const events = await collect(
      readCodexStream(
        sse([
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Let me " },
          { type: "response.output_text.delta", delta: "check." },
          { type: "response.output_item.added", item: { type: "function_call", name: "calendar_read" } },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "c1", name: "calendar_read", arguments: '{"start":"2026-10-22"}' },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 900, output_tokens: 20, input_tokens_details: { cached_tokens: 800 } } },
          },
        ]),
      ),
    );
    expect(events).toEqual([
      { type: "text", text: "Let me " },
      { type: "text", text: "check." },
      { type: "tool_start", name: "calendar_read" },
      { type: "tool_call", call: { id: "c1", name: "calendar_read", input: { start: "2026-10-22" } } },
      { type: "done", finish: "tool_calls", usage: { input: 900, output: 20, cached: 800 } },
    ]);
  });

  it("turns failures into brain errors", async () => {
    await expect(
      collect(readCodexStream(sse([{ type: "response.failed", response: { error: { message: "overloaded" } } }]))),
    ).rejects.toThrow("overloaded");
    await expect(collect(readCodexStream(sse([{ type: "response.output_text.delta", delta: "hi" }])))).rejects.toThrow("ended early");
  });

  it("says why a request was refused", async () => {
    const json = (status: number, body: object) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    expect((await refusal(json(403, { detail: "Unsupported client" }))).message).toBe(
      "ChatGPT refused the request (HTTP 403: Unsupported client).",
    );
    expect((await refusal(json(400, { error: { message: "The 'gpt-9' model is not supported" } }))).message).toContain("gpt-9");
    const page = new Response("<html><title>Just a moment...</title><script>x()</script></html>", {
      status: 403,
      headers: { "cf-mitigated": "challenge" },
    });
    expect((await refusal(page)).message).toBe("ChatGPT's bot check blocked the request from Cloudflare (HTTP 403).");
    expect((await refusal(json(401, {}))).message).toContain("HTTP 401");
  });

  it("maps the thread to Responses input items", () => {
    expect(
      toInput([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "reminder_list", input: {} }] },
        { role: "tool", callId: "c1", name: "reminder_list", content: '{"reminders":[]}' },
      ]),
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "c1", name: "reminder_list", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: '{"reminders":[]}' },
    ]);
  });
});

describe("chatgpt sign-in", () => {
  const jwt = (claims: object) => `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.y`;

  it("reads the account, plan and expiry from the tokens", () => {
    const t = toTokens({
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: "r1",
      id_token: jwt({
        email: "max@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc_1", chatgpt_plan_type: "plus" },
      }),
    });
    expect(t).toMatchObject({ account_id: "acc_1", plan: "plus", email: "max@example.com", expires_at: 2_000_000_000_000 });
    expect(jwtClaims("not-a-jwt")).toEqual({});
  });

  it("runs the device-code flow", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let polls = 0;
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "d1", user_code: "ABCD-EFGH", interval: "1" });
      if (url.endsWith("/deviceauth/token")) {
        polls += 1;
        return polls < 2
          ? new Response("", { status: 403 })
          : Response.json({ authorization_code: "code1", code_verifier: "ver1", code_challenge: "ch1" });
      }
      if (url.endsWith("/oauth/token"))
        return Response.json({ access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "r1", id_token: jwt({}) });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const login = await startDeviceLogin(f);
    expect(login).toMatchObject({ user_code: "ABCD-EFGH", verification_url: "https://auth.openai.com/codex/device", interval: 2 });
    expect(await pollDeviceLogin(login, f)).toBe("pending");
    const tokens = await pollDeviceLogin(login, f);
    expect(tokens).toMatchObject({ refresh_token: "r1" });
    const exchange = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(new URLSearchParams(exchange.body).get("code_verifier")).toBe("ver1");
    expect(new URLSearchParams(exchange.body).get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
  });
});

describe("workers ai brain", () => {
  it("reads the OpenAI chunk shape, with tool calls split across chunks", async () => {
    const events = await collect(
      readWorkersAIStream(
        sse([
          { choices: [{ delta: { content: "On it." } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "reminder_", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "create", arguments: '{"text":"call mom",' } }] } }] },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"at":"2026-10-22T18:00"}' } }] }, finish_reason: "tool_calls" },
            ],
          },
          { usage: { prompt_tokens: 50, completion_tokens: 9 } },
          "[DONE]",
        ]),
      ),
    );
    expect(events).toEqual([
      { type: "text", text: "On it." },
      { type: "tool_start", name: "reminder_" },
      { type: "tool_call", call: { id: "t1", name: "reminder_create", input: { text: "call mom", at: "2026-10-22T18:00" } } },
      { type: "done", finish: "tool_calls", usage: { input: 50, output: 9, cached: undefined } },
    ]);
  });

  it("reads the older { response } shape", async () => {
    const events = await collect(
      readWorkersAIStream(
        sse([{ response: "Hel" }, { response: "lo" }, { response: "", tool_calls: [{ name: "reminder_list", arguments: {} }] }, "[DONE]"]),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["text", "text", "tool_start", "tool_call", "done"]);
  });

  it("maps tool turns to chat messages", () => {
    const m = toChatMessages("sys", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "reminder_list", input: {} }] },
      { role: "tool", callId: "c1", name: "reminder_list", content: "[]" },
    ]);
    expect(m[0]).toEqual({ role: "system", content: "sys" });
    expect(m[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "reminder_list", arguments: "{}" } }],
    });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "c1", name: "reminder_list", content: "[]" });
  });
});

describe("brain router", () => {
  it("skips unconfigured brains and puts cooling ones last", () => {
    const a = scripted([], "codex", "a").brain;
    const b = scripted([], "workers-ai", "b").brain;
    const router = new BrainRouter((c) => (c.model === "a" ? a : c.model === "b" ? b : null));
    const chain = [
      { provider: "codex" as const, model: "a" },
      { provider: "workers-ai" as const, model: "b" },
      { provider: "codex" as const, model: "missing" },
    ];
    expect(router.chain(chain).map((x) => x.model)).toEqual(["a", "b"]);
    router.markFailed(a, new BrainError("down"));
    expect(router.chain(chain).map((x) => x.model)).toEqual(["b", "a"]);
    expect(router.snapshot()["codex:a"]).toMatchObject({ ok: false, reason: "down" });
    router.markOk(a);
    expect(router.chain(chain).map((x) => x.model)).toEqual(["a", "b"]);
  });
});

describe("secrets scrubber", () => {
  it("hides secrets, even split across streamed chunks", () => {
    expect(scrub("key is sk_live_123456789", ["sk_live_123456789"])).toBe("key is [hidden]");
    const s = new StreamScrubber(["sk_live_123456789"]);
    const out = ["the key ", "is sk_li", "ve_1234", "56789 ok"].map((c) => s.push(c)).join("") + s.flush();
    expect(out).toBe("the key is [hidden] ok");
  });
});

describe("sessions", () => {
  it("signs and checks session cookies", async () => {
    const v = await makeSession("s3cret");
    expect(await checkSession("s3cret", v)).toBe(true);
    expect(await checkSession("other", v)).toBe(false);
    expect(await checkSession("s3cret", v.replace(/^\d+/, "9999999999999"))).toBe(false);
    expect(await checkSession("s3cret", await makeSession("s3cret", Date.now() - 40 * 86_400_000))).toBe(false);
  });
});
