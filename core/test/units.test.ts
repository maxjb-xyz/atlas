import { describe, expect, it } from "vitest";
import { chatgptBrain, readResponsesStream, refusal, toInput } from "../src/brains/chatgpt";
import { finishLogin, jwtClaims, listModels, newClient, readCallback, refreshTokens, startLogin } from "../src/brains/chatgpt-auth";
import { BrainRouter } from "../src/brains/router";
import { BrainError } from "../src/brains/types";
import { readWorkersAIStream, toChatMessages } from "../src/brains/workers-ai";
import { scrub, StreamScrubber } from "../src/outbox";
import { isoLocal, parseWhen, shortLocal, startOfLocalDay, addLocalDays } from "../src/time";
import { checkSession, makeSession } from "../src/auth";
import { collect, fakeOpenAI, scripted, sse } from "./helpers";

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

describe("chatgpt brain", () => {
  it("reads text, namespaced tool calls and usage from the Responses stream", async () => {
    const events = await collect(
      readResponsesStream(
        sse([
          { type: "response.created" },
          { type: "response.output_text.delta", delta: "Let me " },
          { type: "response.output_text.delta", delta: "check." },
          { type: "response.output_item.added", item: { type: "function_call", name: "calendar_read" } },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "c1", name: "atlas.calendar_read", arguments: '{"start":"2026-10-22"}' },
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

  it("turns plan errors into plain reasons", async () => {
    await expect(
      collect(
        readResponsesStream(
          sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]),
        ),
      ),
    ).rejects.toThrow("limit for Atlas is used up");
    await expect(collect(readResponsesStream(sse([{ type: "response.output_text.delta", delta: "hi" }])))).rejects.toThrow("ended early");
  });

  it("says why a request was refused", async () => {
    const json = (status: number, body: object) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const notEligible = await refusal(json(403, { error: { code: "subscription_sharing_user_not_eligible", message: "x" } }));
    expect(notEligible.message).toContain("Plus or Pro");
    expect(notEligible.permanent).toBe(true);
    expect((await refusal(json(400, { error: { message: "The 'gpt-9' model is not supported" } }))).message).toContain("gpt-9");
    expect((await refusal(json(403, { detail: "Region not supported" }))).message).toBe(
      "ChatGPT refused the request (HTTP 403: Region not supported).",
    );
  });

  it("calls the public Responses API with the tools in a namespace", async () => {
    let sent: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      return new Response(
        sse([
          { type: "response.output_text.delta", delta: "Hi." },
          { type: "response.completed", response: {} },
        ]),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const brain = chatgptBrain({ access: async () => "tok" }, "gpt-6.1-sol", f);
    const events = await collect(
      brain.stream({
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "reminder_list", description: "List", parameters: { type: "object" } }],
      }),
    );
    expect(events[0]).toEqual({ type: "text", text: "Hi." });
    expect(sent!.url).toBe("https://api.openai.com/v1/responses");
    expect(sent!.headers.get("authorization")).toBe("Bearer tok");
    expect(sent!.body).toMatchObject({ model: "gpt-6.1-sol", instructions: "sys", store: false, stream: true });
    expect(sent!.body).not.toHaveProperty("max_output_tokens");
    expect(sent!.body.tools).toEqual([
      {
        type: "namespace",
        name: "atlas",
        description: "Atlas's own tools.",
        tools: [{ type: "function", name: "reminder_list", description: "List", parameters: { type: "object" }, strict: false }],
      },
    ]);
  });

  it("replays tool calls with their namespace", () => {
    expect(
      toInput([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "reminder_list", input: {} }] },
        { role: "tool", callId: "c1", name: "reminder_list", content: '{"reminders":[]}' },
      ]),
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "c1", name: "reminder_list", namespace: "atlas", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: '{"reminders":[]}' },
    ]);
  });
});

describe("sign in with chatgpt", () => {
  it("builds the sign-in address with PKCE and a stable host id", async () => {
    const client = newClient();
    const login = await startLogin(client);
    const u = new URL(login.url);
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(u.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(u.searchParams.get("agent_name_hint")).toBe("Atlas");
    expect(u.searchParams.get("ext_agent_host_id")).toBe(client.host_id);
    expect(client.host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(u.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(u.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const again = await startLogin({ ...client, client_id: "oaiapp_123", email: "max@example.com" });
    expect(new URL(again.url).searchParams.get("client_id")).toBe("oaiapp_123");
    expect(new URL(again.url).searchParams.get("agent_name_hint")).toBeNull();
  });

  it("finishes from the pasted address, checking the ID token", async () => {
    const openai = await fakeOpenAI();
    const login = await startLogin(newClient());
    openai.setNonce(login.nonce);
    const pasted = `http://127.0.0.1:1455/auth/callback?code=c1&state=${login.state}&client_id=oaiapp_123`;
    const tokens = await finishLogin(pasted, login, openai.f);
    expect(tokens).toMatchObject({ access_token: "at1", refresh_token: "rt2", client_id: "oaiapp_123", email: "max@example.com" });
    const exchange = openai.calls[0]!;
    expect(exchange.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(Object.fromEntries(exchange.body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "oaiapp_123",
      code: "c1",
      code_verifier: login.verifier,
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      resource: "https://api.openai.com/v1",
    });
    expect(await listModels("at1", openai.f)).toEqual(["gpt-6.1-sol"]);
  });

  it("refuses a wrong state, a bad ID token, or a sign-in without plan usage", async () => {
    const openai = await fakeOpenAI();
    const login = await startLogin(newClient());
    await expect(finishLogin(`?code=c1&state=nope&client_id=oaiapp_123`, login, openai.f)).rejects.toThrow("isn't from this sign-in");
    openai.setNonce("someone-else");
    await expect(finishLogin(`?code=c1&state=${login.state}&client_id=oaiapp_123`, login, openai.f)).rejects.toThrow("doesn't match");

    const noPlan = await fakeOpenAI({ scope: "openid email" });
    noPlan.setNonce(login.nonce);
    await expect(finishLogin(`?code=c1&state=${login.state}&client_id=oaiapp_123`, login, noPlan.f)).rejects.toThrow(
      "wasn't allowed to use your ChatGPT plan",
    );
    expect(readCallback(`?error=access_denied&state=${login.state}`).get("error")).toBe("access_denied");
    await expect(finishLogin(`?error=access_denied&state=${login.state}`, login, openai.f)).rejects.toThrow("cancelled");
  });

  it("refreshes with the issued client id, and asks to sign in again when the grant is gone", async () => {
    const ok = await fakeOpenAI();
    const tokens = {
      access_token: "a",
      refresh_token: "r1",
      id_token: "",
      client_id: "oaiapp_123",
      email: null,
      scopes: ["chatgpt.tokens.use.direct"],
      expires_at: 0,
    };
    const fresh = await refreshTokens(tokens, ok.f);
    expect(fresh).toMatchObject({ access_token: "at1", refresh_token: "rt2", client_id: "oaiapp_123" });
    expect(Object.fromEntries(ok.calls[0]!.body)).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_123",
      refresh_token: "r1",
      resource: "https://api.openai.com/v1",
    });
    const gone = await fakeOpenAI({ tokenStatus: 400, tokenBody: { error: "refresh_token_reused" } });
    await expect(refreshTokens(tokens, gone.f)).rejects.toThrow("Sign in again");
    expect(jwtClaims("not-a-jwt")).toEqual({});
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
    const a = scripted([], "chatgpt", "a").brain;
    const b = scripted([], "workers-ai", "b").brain;
    const router = new BrainRouter((c) => (c.model === "a" ? a : c.model === "b" ? b : null));
    const chain = [
      { provider: "chatgpt" as const, model: "a" },
      { provider: "workers-ai" as const, model: "b" },
      { provider: "chatgpt" as const, model: "missing" },
    ];
    expect(router.chain(chain).map((x) => x.model)).toEqual(["a", "b"]);
    router.markFailed(a, new BrainError("down"));
    expect(router.chain(chain).map((x) => x.model)).toEqual(["b", "a"]);
    expect(router.snapshot()["chatgpt:a"]).toMatchObject({ ok: false, reason: "down" });
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
