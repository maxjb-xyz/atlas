import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import type { ServerMessage } from "../src/protocol";
import { CalendarError } from "../src/calendar/types";
import { getItem } from "../src/store/agenda";
import type { LogRow } from "../src/store/log";
import { call, collect, env, fakeCalendar, fakeEmbedder, fakeOpenAI, say, scripted, SECRET, type Step } from "./helpers";

const ORIGIN = "http://atlas.test";
const auth = { authorization: `Bearer ${SECRET}` };

interface Socket {
  ws: WebSocket;
  inbox: ServerMessage[];
  send(msg: object): void;
  next<T extends ServerMessage["type"]>(
    type: T,
    where?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
}

async function connect(headers: Record<string, string> = auth): Promise<Socket> {
  const res = await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, { headers: { Upgrade: "websocket", ...headers } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no socket: ${res.status}`);
  ws.accept();
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as { type?: string };
    if (m.type?.startsWith("atlas.")) {
      inbox.push(m as ServerMessage);
      for (const w of waiters.splice(0)) w();
    }
  });
  return {
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    async next(type, where = () => true) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const i = inbox.findIndex((m) => m.type === type && where(m as never));
        if (i >= 0) return inbox.splice(i, 1)[0] as never;
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
      throw new Error(`no ${type} within 5 s; got ${inbox.map((m) => m.type).join(", ")}`);
    },
  };
}

const owner = () => env.PersonAgent.get(env.PersonAgent.idFromName("owner"));
const rowsOf = (m: Extract<ServerMessage, { type: "atlas.rows" }>, kind: string): LogRow[] => m.rows.filter((r) => r.kind === kind);

function brains(main: Step[], voice: Step[] = []) {
  const m = scripted(main, "chatgpt", "gpt-5.6-terra");
  const v = scripted(voice, "workers-ai", "@cf/moonshotai/kimi-k2.6");
  seams.makeBrain = (c) => (c.provider === "chatgpt" ? m.brain : v.brain);
  return { main: m, voice: v };
}

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.fetch = null;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("sign-in", () => {
  it("refuses the app and the socket without the owner", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/turn`, { method: "POST" })).status).toBe(401);
    const res = await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("refuses another person's agent name and other origins", async () => {
    expect((await SELF.fetch(`${ORIGIN}/agents/person-agent/someone`, { headers: { Upgrade: "websocket", ...auth } })).status).toBe(404);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, {
          headers: { Upgrade: "websocket", origin: "https://evil.example", ...auth },
        })
      ).status,
    ).toBe(403);
  });

  it("trades the secret for a session cookie", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/login`, { method: "POST", body: JSON.stringify({ secret: "wrong" }) })).status).toBe(401);
    const ok = await SELF.fetch(`${ORIGIN}/api/login`, { method: "POST", body: JSON.stringify({ secret: SECRET }) });
    expect(ok.status).toBe(204);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^atlas_session=/);
    const session = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { cookie } });
    expect(await session.json()).toEqual({ configured: true, signed_in: true });
  });
});

describe("the thread", () => {
  it("answers a text message, streams it, and saves it as the truth", async () => {
    brains([call("calendar_read", {}), say("Nothing on today.")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    const snap = await s.next("atlas.snapshot");
    expect(snap.view.settings.timezone).toBe("America/New_York");

    s.send({ type: "atlas.say", text: "anything today?", client_id: "c1" });
    const started = await s.next("atlas.run", (m) => m.state === "running");
    expect(started.client_id).toBe("c1");
    await s.next("atlas.status", (m) => m.text === "Checking your calendar.");
    await s.next("atlas.delta", (m) => m.text.includes("Nothing"));
    const out = await s.next("atlas.rows", (m) => rowsOf(m, "message.out").length > 0);
    expect(rowsOf(out, "message.out")[0]!.body).toMatchObject({
      text: "Nothing on today.",
      channel: "app",
      brain: { provider: "chatgpt" },
    });
    await s.next("atlas.run", (m) => m.state === "replied");

    // A refresh shows the same saved truth.
    s.send({ type: "atlas.hello" });
    const again = await s.next("atlas.snapshot");
    expect(again.thread.map((r) => r.kind)).toEqual(["message.in", "message.out"]);
    s.ws.close();
  });

  it("sets a reminder, lets the owner undo it, and says so in the thread", async () => {
    brains([call("reminder_create", { text: "Stretch", at: "2099-01-01T09:00" }), say("Set for 9.")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.say", text: "remind me to stretch", client_id: "c2" });
    const receiptMsg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    const receipt = rowsOf(receiptMsg, "tool.result")[0]!;
    await s.next("atlas.run", (m) => m.state === "replied");
    const id = (receipt.body.receipt as { undo: { id: string } }).undo.id;

    s.send({ type: "atlas.undo", log_id: receipt.id });
    const undone = await s.next("atlas.rows", (m) => rowsOf(m, "agenda.change").length > 0);
    expect(rowsOf(undone, "agenda.change")[0]!.body).toMatchObject({ change: "cancelled", by: "owner", undo_of: receipt.id });
    const item = await runInDurableObject(owner(), (_i: PersonAgent, state) => getItem(state.storage.sql, id));
    expect(item!.state).toBe("cancelled");
    s.ws.close();
  });

  it("keeps a reminder's promise when it comes due, even with no brain", async () => {
    brains([call("reminder_create", { text: "Take the bread out", at: "2099-01-01T09:00" }), say("Will do."), new Error("down")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.say", text: "remind me", client_id: "c3" });
    const receiptMsg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    await s.next("atlas.run", (m) => m.state === "replied");
    const id = (rowsOf(receiptMsg, "tool.result")[0]!.body.receipt as { undo: { id: string } }).undo.id;

    // Make it due now, then fire it the way the alarm would.
    await runInDurableObject(owner(), async (agent: PersonAgent, state) => {
      state.storage.sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, id);
      await agent.onAgendaDue({ id });
    });
    const delivered = await s.next("atlas.rows", (m) => rowsOf(m, "message.out").some((r) => r.body.trigger === `agenda:${id}`));
    expect(rowsOf(delivered, "message.out")[0]!.body.text).toBe("Reminder: Take the bread out");
    const item = await runInDurableObject(owner(), (_i: PersonAgent, state) => getItem(state.storage.sql, id));
    expect(item!.state).toBe("done");
    s.ws.close();
  });

  it("notes a fact with a chip, uses it next time, and undoes it from the chip", async () => {
    const { main } = brains([
      call("remember", { type: "preference", name: "Diet", fact: "The owner is vegetarian." }),
      say("Noted."),
      say("How about the Thai place?"),
      say("Sure."),
    ]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.say", text: "I'm vegetarian", client_id: "m1" });
    const chipMsg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    const chip = rowsOf(chipMsg, "tool.result")[0]!;
    expect(chip.body.receipt).toMatchObject({ text: "Noted · The owner is vegetarian.", undo: { kind: "record.forget" } });
    await s.next("atlas.run", (m) => m.state === "replied");

    // The next run has it in view, without being asked.
    s.send({ type: "atlas.say", text: "dinner Friday?", client_id: "m2" });
    await s.next("atlas.run", (m) => m.state === "replied" && m.run_id !== chip.run_id);
    expect(main.requests[2]!.system).toContain("- The owner is vegetarian. (id rec_");
    expect(main.requests[2]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["remember", "forget", "recall"]));

    // Undo from the chip forgets it, and the thread says so.
    s.send({ type: "atlas.undo", log_id: chip.id });
    const undone = await s.next("atlas.rows", (m) => rowsOf(m, "record.change").length > 0);
    expect(rowsOf(undone, "record.change")[0]!.body).toMatchObject({ change: "forgotten", by: "owner", undo_of: chip.id });
    s.send({ type: "atlas.undo", log_id: chip.id });
    expect((await s.next("atlas.error")).message).toBe("That's already undone.");
    s.send({ type: "atlas.say", text: "ok", client_id: "m3" });
    await s.next("atlas.run", (m) => m.state === "replied" && m.client_id === undefined && main.requests.length === 4);
    expect(main.requests[3]!.system).not.toContain("vegetarian");

    // The thread and the memory index both caught up.
    await runInDurableObject(owner(), (agent: PersonAgent) => agent.apiSettleMemory());
    const indexed = await runInDurableObject(
      owner(),
      (_i: PersonAgent, state) =>
        state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM memory WHERE kind = 'message' AND model = 'fake-embed'`).one().n,
    );
    expect(indexed).toBeGreaterThan(0);
    s.ws.close();
  });

  it("doesn't let the clock's own runs save facts about the owner", async () => {
    const { main } = brains([
      call("reminder_create", { text: "Water plants", at: "2099-01-01T09:00" }),
      say("Set."),
      say("Time to water the plants."),
    ]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.say", text: "remind me", client_id: "k1" });
    const receiptMsg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    await s.next("atlas.run", (m) => m.state === "replied");
    const id = (rowsOf(receiptMsg, "tool.result")[0]!.body.receipt as { undo: { id: string } }).undo.id;
    await runInDurableObject(owner(), async (agent: PersonAgent, state) => {
      state.storage.sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, id);
      await agent.onAgendaDue({ id });
    });
    const tools = main.requests[2]!.tools.map((t) => t.name);
    expect(tools).toContain("recall");
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("forget");
    s.ws.close();
  });

  it("tells the owner what Atlas holds for iCloud when it's refused, without the password", async () => {
    brains([]);
    seams.calendar = {
      list: async () => [],
      check: async () => {
        throw new CalendarError("iCloud didn't accept the Apple ID and app-specific password.", "auth");
      },
    };
    const s = await connect();
    s.send({
      type: "atlas.secret.set",
      secret: { name: "icloud", value: { username: " owner@icloud.com ", app_password: "abcd efgh ijkl mnop" } },
    });
    expect((await s.next("atlas.view")).view.secrets.icloud).toEqual({ username: "owner@icloud.com", refused: null });
    s.send({ type: "atlas.test", what: "calendar", ref: "cal" });
    const res = await s.next("atlas.test.result", (m) => m.ref === "cal");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("signing in as owner@icloud.com with a 16-character password not in Apple's");
    expect(res.message).not.toContain("abcdefghijklmnop");
    s.ws.close();
  });

  it("stops asking iCloud after it refuses the password, until the owner reconnects", async () => {
    let asked = 0;
    seams.calendar = {
      list: async () => {
        asked += 1;
        throw new CalendarError("iCloud didn't accept the Apple ID and app-specific password.", "auth");
      },
      check: async () => ({ calendars: [], events_next_30_days: 0 }),
    };
    brains([call("calendar_read", {}, "c1"), call("calendar_read", {}, "c2"), say("iCloud refused the password.")]);
    const s = await connect();
    s.send({
      type: "atlas.secret.set",
      secret: { name: "icloud", value: { username: "owner@icloud.com", app_password: "abcd-efgh-ijkl-mnop" } },
    });
    await s.next("atlas.view");
    s.send({ type: "atlas.say", text: "what's on today?", client_id: "c9" });
    const refused = await s.next("atlas.view", (m) => Boolean(m.view.secrets.icloud?.refused));
    expect(refused.view.secrets.icloud!.refused!.message).toContain("didn't accept");
    await s.next("atlas.run", (m) => m.state === "replied");
    expect(asked).toBe(1); // the brain asked twice; iCloud was only asked once

    // Reconnecting lets Atlas ask again.
    s.send({
      type: "atlas.secret.set",
      secret: { name: "icloud", value: { username: "owner@icloud.com", app_password: "wxyz-wxyz-wxyz-wxyz" } },
    });
    const fresh = await s.next("atlas.view", (m) => m.view.secrets.icloud?.refused === null);
    expect(fresh.view.secrets.icloud!.username).toBe("owner@icloud.com");
    s.send({ type: "atlas.secret.set", secret: { name: "icloud", value: null } });
    await s.next("atlas.view");
    s.ws.close();
  });

  it("never sends secrets to the app", async () => {
    brains([]);
    const s = await connect();
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: "sk_eleven_secret_value" } });
    const view = await s.next("atlas.view");
    expect(view.view.secrets.elevenlabs_api_key).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk_eleven_secret_value");
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: null } });
    expect((await s.next("atlas.view")).view.secrets.elevenlabs_api_key).toBe(false);
    s.ws.close();
  });
});

describe("sign in with chatgpt", () => {
  it("signs in from the pasted address and points the chains at a model the account has", async () => {
    const openai = await fakeOpenAI();
    seams.fetch = openai.f;
    const s = await connect();
    s.send({ type: "atlas.chatgpt.start" });
    const pending = await s.next("atlas.view", (m) => m.view.chatgpt.state === "pending");
    const url = new URL((pending.view.chatgpt as { authorize_url: string }).authorize_url);
    openai.setNonce(url.searchParams.get("nonce")!);
    const landed = `http://127.0.0.1:1455/auth/callback?code=c1&state=${url.searchParams.get("state")}&client_id=oaiapp_123`;
    s.send({ type: "atlas.chatgpt.finish", url: landed });
    const done = await s.next("atlas.view", (m) => m.view.chatgpt.state === "signed_in");
    expect(done.view.chatgpt).toMatchObject({ email: "max@example.com", models: ["gpt-6.1-sol"] });
    expect(done.view.settings.brains.main[0]).toEqual({ provider: "chatgpt", model: "gpt-6.1-sol" });
    expect(JSON.stringify(done.view)).not.toContain("rt2");

    // Signing in again reuses the client id OpenAI issued.
    s.send({ type: "atlas.chatgpt.start" });
    const again = await s.next("atlas.view", (m) => m.view.chatgpt.state === "pending");
    expect(new URL((again.view.chatgpt as { authorize_url: string }).authorize_url).searchParams.get("client_id")).toBe("oaiapp_123");
    s.send({ type: "atlas.chatgpt.cancel" });
    s.ws.close();
  });
});

describe("voice", () => {
  it("says the status line while the lookup is still running", async () => {
    const b = brains([], [call("calendar_read", {})]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = b.voice.brain.stream.bind(b.voice.brain);
    let calls = 0;
    b.voice.brain.stream = async function* (req) {
      calls += 1;
      if (calls === 1) {
        yield* first(req);
        return;
      }
      await gate;
      yield { type: "text", text: "You're free." };
      yield { type: "done", finish: "stop" };
    };
    // A long stored secret used to hold back every word until the turn ended.
    const s = await connect();
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: `sk_${"x".repeat(180)}` } });
    await s.next("atlas.view");
    const said = await runInDurableObject(owner(), async (agent: PersonAgent) => {
      const spoken = await agent.onTurn("am I free", {
        connection: { id: "voice-2" } as never,
        messages: [],
        signal: new AbortController().signal,
      });
      const it = (spoken as AsyncIterable<string>)[Symbol.asyncIterator]();
      const status = await it.next();
      release();
      let rest = "";
      for (let x = await it.next(); !x.done; x = await it.next()) rest += x.value;
      return { status: status.value as string, rest };
    });
    expect(said).toEqual({ status: "Checking your calendar. ", rest: "You're free." });
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: null } });
    await s.next("atlas.view");
    s.ws.close();
  });

  it("is the same mind: same log, same tools, and a status line before a lookup", async () => {
    const b = brains([], [call("calendar_read", {}), say("You're free all afternoon.")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");

    const words = await runInDurableObject(owner(), async (agent: PersonAgent) => {
      const spoken = await agent.onTurn("am I free this afternoon", {
        connection: { id: "voice-1" } as never,
        messages: [],
        signal: new AbortController().signal,
      });
      return collect(spoken as AsyncIterable<string>);
    });
    expect(words.join("")).toBe("Checking your calendar. You're free all afternoon.");
    expect(b.voice.requests[0]!.system).toContain("speaking out loud");
    expect(b.voice.requests[0]!.tools.map((t) => t.name)).toContain("calendar_read");

    const saved = await s.next("atlas.rows", (m) => rowsOf(m, "message.out").length > 0);
    const timing = rowsOf(saved, "message.out")[0]!.body.timing as { status_ms: number; answer_ms: number };
    expect(timing.status_ms).toBeLessThanOrEqual(timing.answer_ms);
    expect(rowsOf(saved, "message.out")[0]).toMatchObject({
      surface: "voice",
      body: { text: "Checking your calendar. You're free all afternoon." },
    });
    s.ws.close();
  });
});

describe("the HTTP API", () => {
  it("runs a text turn for the benchmark", async () => {
    brains([say("Hello from the API.")]);
    const res = await SELF.fetch(`${ORIGIN}/api/turn`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hi" }) });
    expect(await res.json()).toMatchObject({ state: "replied", reply: "Hello from the API.", brain: "chatgpt:gpt-5.6-terra" });
    const log = (await (await SELF.fetch(`${ORIGIN}/api/log?since=0`, { headers: auth })).json()) as { rows: LogRow[] };
    expect(log.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["message.in", "message.out", "run.end"]));
  });
});
