import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams, type SpeechPart } from "../src/agent";
import type { ServerMessage } from "../src/protocol";
import { CalendarError } from "../src/calendar/types";
import { getItem } from "../src/store/agenda";
import { migrate } from "../src/store/db";
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
    expect(await session.json()).toEqual({
      configured: true,
      signed_in: true,
      has_passkeys: false,
      person: { member: null, agent: "owner" },
    });
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

  it("draws a day it read under the reply when asked what the day looks like", async () => {
    brains([call("calendar_read", { start: "2099-03-03", show: true }), say("A quiet one.")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.say", text: "what does that Tuesday look like?", client_id: "cd" });
    const msg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    expect(rowsOf(msg, "tool.result")[0]!.body.receipt).toMatchObject({ view: { kind: "day", date: "2099-03-03" } });
    await s.next("atlas.run", (m) => m.state === "replied");
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

  it("pushes a reminder to the device used last only while no app is in view", async () => {
    const pushes: string[] = [];
    seams.fetch = (async (url: string) => {
      pushes.push(String(url));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    brains([
      call("reminder_create", { text: "Stretch", at: "2099-01-01T09:00" }),
      say("Set."),
      say("Time to stretch."),
      call("reminder_create", { text: "Water", at: "2099-01-01T09:00" }, "call_2"),
      say("Set."),
      say("Drink some water."),
    ]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    const endpoint = "https://web.push.apple.com/QGuQyavXutnMH";
    s.send({
      type: "atlas.push.subscribe",
      device: "phone-1",
      name: "iPhone",
      origin: "https://atlas.example.workers.dev",
      subscription: {
        endpoint,
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      },
    });
    const view = await s.next("atlas.view", (m) => m.view.push.devices.length === 1);
    expect(view.view.push.public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/);

    const fire = async (said: string, visible: boolean) => {
      s.send({ type: "atlas.presence", device: "phone-1", visible: true });
      s.send({ type: "atlas.say", text: said, client_id: said });
      const receiptMsg = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
      await s.next("atlas.run", (m) => m.state === "replied");
      const id = (rowsOf(receiptMsg, "tool.result")[0]!.body.receipt as { undo: { id: string } }).undo.id;
      s.send({ type: "atlas.presence", device: "phone-1", visible });
      // Messages are handled in order: once Inbox answers, the presence has landed.
      s.send({ type: "atlas.inbox" });
      await s.next("atlas.inbox.items");
      await runInDurableObject(owner(), async (agent: PersonAgent, state) => {
        state.storage.sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, id);
        await agent.onAgendaDue({ id });
      });
    };

    // The app is in view on this device: the reminder shows there, with no push as well.
    await fire("remind me to stretch", true);
    expect(pushes).toEqual([]);

    // Put away: the next one is pushed, once, and History has the receipt.
    await fire("remind me to drink water", false);
    const delivered = await s.next("atlas.rows", (m) => rowsOf(m, "delivery").length > 0);
    expect(rowsOf(delivered, "delivery")[0]!.body).toMatchObject({ channel: "push", to: "iPhone", ok: true });
    expect(pushes).toEqual([endpoint]);
    s.ws.close();
  });

  it("puts a view on the stage, keeps it on the receipt, and serves the page behind it", async () => {
    brains([call("show", { view: { kind: "area", area: "Studio" } }), say("Here's the studio.")]);
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.area.create", name: "Studio", about: "Where I edit" });
    const areas = await s.next("atlas.areas", (m) => m.areas.some((a) => a.name === "Studio"));
    const studio = areas.areas.find((a) => a.name === "Studio")!;

    s.send({ type: "atlas.say", text: "what's going on with the studio?", client_id: "c-show" });
    const shown = await s.next("atlas.rows", (m) => rowsOf(m, "tool.result").length > 0);
    const row = rowsOf(shown, "tool.result")[0]!;
    expect(row.body.receipt).toEqual({ text: "Showing · Studio", view: { kind: "area", area: studio.id } });
    await s.next("atlas.run", (m) => m.state === "replied");

    // A refresh still has it: the log is the truth.
    s.send({ type: "atlas.hello" });
    const again = await s.next("atlas.snapshot");
    expect(again.thread.some((r) => r.id === row.id)).toBe(true);

    s.send({ type: "atlas.stage", ref: "t", view: { kind: "area", area: studio.id } });
    const page = await s.next("atlas.stage.page", (m) => m.ref === "t");
    expect(page.page).toMatchObject({ kind: "area", area: { name: "Studio", about: "Where I edit" }, people: [] });
    s.ws.close();
  });

  it("sets an area's color and icon from the app, keeping an uploaded logo in the files store", async () => {
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    await s.next("atlas.snapshot");
    s.send({ type: "atlas.area.create", name: "Riverside", about: "A client" });
    const made = await s.next("atlas.areas", (m) => m.areas.some((a) => a.name === "Riverside"));
    const area = made.areas.find((a) => a.name === "Riverside")!;
    expect(area).toMatchObject({ custom_color: null, icon: null });

    s.send({ type: "atlas.area.look", id: area.id, custom_color: "#123abc", icon: "film" });
    const looked = await s.next("atlas.areas", (m) => m.areas.some((a) => a.id === area.id && a.icon === "film"));
    expect(looked.areas.find((a) => a.id === area.id)).toMatchObject({ custom_color: "#123abc", icon: "film" });

    // A logo: kept as a file, and the area points at it.
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
    s.send({ type: "atlas.area.look", id: area.id, image: { name: "logo.png", type: "image/png", data: png } });
    const logo = await s.next("atlas.areas", (m) => m.areas.some((a) => a.id === area.id && a.icon?.startsWith("file:") === true));
    const file = logo.areas.find((a) => a.id === area.id)!.icon!.slice(5);
    expect(await (await env.FILES.get(`files/${file}`))!.arrayBuffer()).toHaveProperty("byteLength", 8);

    // Something it can't use says why, in words.
    s.send({ type: "atlas.area.look", id: area.id, image: { name: "x.png", type: "image/png", data: "%%%" } });
    expect((await s.next("atlas.error")).message).toMatch(/didn't arrive whole/);
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

  it("sets iCloud up as an extension: the Apple ID as a setting, the password as a secret Settings never shows", async () => {
    brains([]);
    const s = await connect();
    s.send({ type: "atlas.ext.install", id: "icloud" });
    s.send({ type: "atlas.ext.settings", id: "icloud", settings: { username: " owner@icloud.com " } });
    s.send({ type: "atlas.ext.secrets", id: "icloud", secrets: { app_password: "abcd-efgh-ijkl-mnop" } });
    const v = await s.next("atlas.view", (m) => m.view.extensions.some((e) => e.id === "icloud" && e.secrets.some((x) => x.set)));
    const ext = v.view.extensions.find((e) => e.id === "icloud")!;
    expect(ext).toMatchObject({ state: "on", provides: ["calendar", "contacts"], hosts: ["icloud.com"] });
    expect(ext.settings.find((x) => x.name === "username")!.value).toBe("owner@icloud.com");
    expect(JSON.stringify(v.view)).not.toContain("abcd-efgh");
    expect(v.view.calendar.provider).toEqual({ id: "icloud", name: "iCloud" });
    s.send({ type: "atlas.ext.remove", id: "icloud" });
    await s.next("atlas.view", (m) => !m.view.extensions.some((e) => e.id === "icloud" && e.state !== "available"));
    s.ws.close();
  });

  it("after iCloud refuses, answers from its copy, waits before trying again, and recovers by itself", async () => {
    let asked = 0;
    let refuse = true;
    const copyAt = Date.now() - 3_600_000;
    const held = [
      { id: "e1", calendar: "Home", title: "Dentist", start: new Date().toISOString(), end: new Date().toISOString(), all_day: false },
    ];
    seams.calendar = {
      list: async () => {
        asked += 1;
        if (refuse)
          throw new CalendarError("iCloud didn't accept the Apple ID and app-specific password (HTTP 401 at caldav.icloud.com)", "auth");
        return held;
      },
      held: async () => ({ events: held, as_of: copyAt }),
      check: async () => ({ calendars: [], events_next_30_days: 0 }),
    };
    brains([call("calendar_read", {}, "c1"), call("calendar_read", {}, "c2"), say("You have the dentist.")]);
    const s = await connect();
    s.send({ type: "atlas.say", text: "what's on today?", client_id: "c9" });
    const refused = await s.next("atlas.view", (m) => Boolean(m.view.calendar.refused));
    const r = refused.view.calendar.refused!;
    expect(r.message).toContain("didn't accept");
    expect(r.next_try - r.at).toBe(30 * 60_000);
    await s.next("atlas.run", (m) => m.state === "replied");
    // The brain read twice; iCloud was asked once, and both reads were answered from the copy, with its age and why.
    expect(asked).toBe(1);
    const results = await runInDurableObject(owner(), async (_a: PersonAgent, state) =>
      state.storage.sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'tool.result' ORDER BY seq DESC LIMIT 2`)
        .toArray()
        .map((x) => JSON.parse(JSON.parse(x.body).output) as { events: unknown[]; as_of?: string; why_not_live?: string }),
    );
    for (const out of results) {
      expect(out.events).toHaveLength(1);
      expect(out.as_of).toBeTruthy();
      expect(out.why_not_live).toContain("Atlas will try again by itself after");
    }

    // Once the wait is over, the next read tries iCloud again; it accepts, and the refusal clears with no help from the owner.
    refuse = false;
    await runInDurableObject(owner(), async (_a: PersonAgent, state) => {
      // Each calendar's refusal is kept by its extension; the test calendar has none, so it's "".
      const row = state.storage.sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = 'calendar_refusals'`).one();
      const all = JSON.parse(row.value) as Record<string, { next_try: number }>;
      all[""]!.next_try = Date.now() - 1;
      state.storage.sql.exec(`UPDATE state SET value = ? WHERE key = 'calendar_refusals'`, JSON.stringify(all));
    });
    const today = new Date().toISOString().slice(0, 10);
    s.send({ type: "atlas.calendar", ref: "now", start: today, end: today + "T23:59" });
    const ok = await s.next("atlas.calendar.events", (m) => m.ref === "now");
    expect(ok.stale).toBeUndefined();
    expect(asked).toBe(2);
    await s.next("atlas.view", (m) => m.view.calendar.refused === null);
    s.ws.close();
  });

  it("reads a refusal saved by the version before, instead of failing to load", async () => {
    seams.calendar = fakeCalendar([]);
    await runInDurableObject(owner(), async (_a: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      // M0's shape: no tries, no next_try.
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('icloud_refused', ?, ?)`,
        JSON.stringify({ at: Date.now() - 60_000, message: "iCloud didn't accept the Apple ID and app-specific password." }),
        Date.now(),
      );
    });
    const s = await connect();
    s.send({ type: "atlas.hello", tz: "America/New_York" });
    const snap = await s.next("atlas.snapshot");
    const r = snap.view.calendar.refused!;
    expect(r.tries).toBe(1);
    expect(r.next_try - r.at).toBe(30 * 60_000);
    expect(r.note).toContain("Atlas will try again by itself after");
    await runInDurableObject(owner(), async (_a: PersonAgent, state) =>
      state.storage.sql.exec(`DELETE FROM state WHERE key IN ('icloud_refused', 'calendar_refusals')`),
    );
    s.ws.close();
  });

  it("says the calendar can't be read when it holds no copy to answer from", async () => {
    seams.calendar = {
      list: async () => {
        throw new CalendarError("iCloud Calendar didn't answer in time. Try again in a minute.", "network");
      },
      check: async () => ({ calendars: [], events_next_30_days: 0 }),
    };
    const s = await connect();
    s.send({ type: "atlas.calendar", ref: "x", start: "2026-10-22", end: "2026-10-23" });
    const res = await s.next("atlas.calendar.events", (m) => m.ref === "x");
    expect(res.events).toEqual([]);
    expect(res.error).toContain("didn't answer in time");
    s.ws.close();
  });

  it("never sends secrets to the app", async () => {
    brains([]);
    const s = await connect();
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: "sk_eleven_secret_value" } });
    const view = await s.next("atlas.view", (m) => m.view.secrets.elevenlabs_api_key);
    expect(view.view.secrets.elevenlabs_api_key).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk_eleven_secret_value");
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: null } });
    expect((await s.next("atlas.view")).view.secrets.elevenlabs_api_key).toBe(false);
    s.ws.close();
  });
});

describe("setup", () => {
  it("records steps, lists voices, and takes Atlas's first look", async () => {
    brains([
      call("calendar_read", { start: "2099-01-01", end: "2099-01-15" }),
      say(
        '{"areas": [{"name": "Keyframes", "about": "video studio"}], "people": [{"name": "Dana", "why": "producer"}], "notes": ["Two clashes Thursday."], "question": "What matters most to you this month?"}',
      ),
    ]);
    seams.fetch = (async (url: string) => {
      if (String(url).startsWith("https://api.elevenlabs.io/v2/voices"))
        return Response.json({
          voices: [{ voice_id: "v1", name: "George", preview_url: "https://x/p.mp3", labels: { accent: "british" } }],
        });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const s = await connect();
    s.send({ type: "atlas.setup.step", step: "passkey", state: "done" });
    s.send({ type: "atlas.setup.step", step: "connect", state: "skipped" });
    const view = await s.next("atlas.view", (m) => m.view.setup.skipped.includes("connect"));
    expect(view.view.setup).toMatchObject({ done: ["passkey"], skipped: ["connect"], finished: false });

    s.send({ type: "atlas.voices.list" });
    expect((await s.next("atlas.voices")).error).toContain("Add an ElevenLabs API key");
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: "sk_eleven_test_key" } });
    await s.next("atlas.view", (m) => m.view.secrets.elevenlabs_api_key);
    s.send({ type: "atlas.voices.list" });
    expect((await s.next("atlas.voices", (m) => m.voices.length > 0)).voices).toEqual([
      { id: "v1", name: "George", preview_url: "https://x/p.mp3", description: "british" },
    ]);

    s.send({ type: "atlas.setup.look" });
    const look = await s.next("atlas.setup.look.result");
    expect(look.look).toEqual({
      areas: [{ name: "Keyframes", about: "video studio" }],
      people: [{ name: "Dana", why: "producer" }],
      notes: ["Two clashes Thursday."],
      question: "What matters most to you this month?",
    });
    // The first message ends with the question.
    const first = await runInDurableObject(owner(), (_i: PersonAgent, state) =>
      state.storage.sql
        .exec<{ t: string }>(`SELECT json_extract(body, '$.text') AS t FROM log WHERE kind = 'message.out' ORDER BY seq DESC LIMIT 1`)
        .one(),
    );
    expect(first.t).toMatch(/Two clashes Thursday\.\n\nWhat matters most to you this month\?$/);
    s.send({ type: "atlas.setup.people", people: [{ name: "Dana", why: "producer" }] });
    // Saved as it's taken in; any view that comes meanwhile says nothing about it, so the records are asked until they have it.
    let people: Array<{ name: string }> = [];
    for (let i = 0; i < 50 && !people.some((p) => p.name === "Dana"); i++) {
      people = await runInDurableObject(owner(), (_i: PersonAgent, state) =>
        state.storage.sql.exec<{ name: string }>(`SELECT name FROM records WHERE type = 'person'`).toArray(),
      );
      if (!people.some((p) => p.name === "Dana")) await new Promise((r) => setTimeout(r, 40));
    }
    expect(people.map((p) => p.name)).toContain("Dana");
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
    await s.next("atlas.view", (m) => m.view.secrets.elevenlabs_api_key);
    const said = await runInDurableObject(owner(), async (agent: PersonAgent) => {
      const spoken = await agent.onTurn("am I free", {
        connection: { id: "voice-2" } as never,
        messages: [],
        signal: new AbortController().signal,
      });
      const it = (spoken as AsyncIterable<SpeechPart>)[Symbol.asyncIterator]();
      const status = await it.next();
      const pause = await it.next();
      release();
      let rest = "";
      for (let x = await it.next(); !x.done; x = await it.next()) rest += x.value.type === "text-delta" ? x.value.text : "|";
      return { status: status.value, pause: pause.value, rest };
    });
    // The status line is spoken before the lookup answers: a break follows it.
    expect(said).toEqual({
      status: { type: "text-delta", text: "Checking your calendar. " },
      pause: { type: "finish-step" },
      rest: "You're free.",
    });
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
      return collect(spoken as AsyncIterable<SpeechPart>);
    });
    expect(words.map((w) => (w.type === "text-delta" ? w.text : "|")).join("")).toBe("Checking your calendar. |You're free all afternoon.");
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
