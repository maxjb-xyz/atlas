import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { askedOn, type Channels, FOLLOW_UP_MS, type Note, Outbox, type PushDevice, pushDevices, route } from "../src/outbox";
import { b64url, encryptPayload, fromB64url, type PushSubscriptionJSON, vapidAuth, vapidKeys } from "../src/push";
import { createItem } from "../src/store/agenda";
import { migrate, type Sql } from "../src/store/db";
import { append, type LogRow } from "../src/store/log";
import { readSettings, Settings, setSecret, writeSettings } from "../src/store/settings";
import { setState } from "../src/store/state";
import { quietUntil } from "../src/time";
import { setFocus } from "../src/tools/focus";
import { env } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`o-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

const enc = new TextEncoder();

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) {
    out.set(x, i);
    i += x.length;
  }
  return out;
};

/** A browser's side of push: its own key pair and auth secret, and the decryption a browser does (RFC 8291). */
async function fakeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: PushSubscriptionJSON = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: { p256dh: b64url(uaPublic), auth: b64url(auth) },
  };
  async function decrypt(body: Uint8Array): Promise<unknown> {
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const sealed = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256),
    );
    const ikm = await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
    const prk = await hmac(salt, ikm);
    const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
    const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
    expect(plain[plain.length - 1]).toBe(2); // the last record's delimiter
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
  }
  return { sub, decrypt };
}

/** A fake network: records every request, answers from `answer`. */
function fakeNet(answer: (url: string, init: RequestInit) => Response = () => new Response(null, { status: 201 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

function outbox(sql: Sql, f: typeof fetch, opts: { looking?: boolean; inCall?: boolean } = {}) {
  const held: Array<{ at: Date; row: Note }> = [];
  const shown: LogRow[] = [];
  const channels: Channels = {
    broadcast: (rows) => shown.push(...rows),
    speak: async () => opts.inCall ?? false,
    looking: () => opts.looking ?? false,
    hold: async (at, row) => void held.push({ at, row }),
    fetch: f,
    browser: () => null,
    mcp: () => null,
  };
  return { box: new Outbox(sql, channels), held, shown };
}

function device(id: string, sub: PushSubscriptionJSON, last_seen: number): PushDevice {
  return { id, name: `Phone ${id}`, sub, origin: "https://atlas.example.workers.dev", added_at: 0, last_seen };
}

const receipts = (rows: LogRow[]) => rows.filter((r) => r.kind === "delivery").map((r) => r.body);

afterEach(() => {
  seams.fetch = null;
});

describe("push notifications", () => {
  it("encrypts so only the device can read it, and signs with this deployment's key", () =>
    withSql(async (sql) => {
      const browser = await fakeBrowser();
      const body = await encryptPayload(enc.encode(JSON.stringify({ title: "Atlas", body: "Hi" })), browser.sub);
      expect(await browser.decrypt(body)).toEqual({ title: "Atlas", body: "Hi" });

      const keys = await vapidKeys(sql);
      expect(await vapidKeys(sql)).toEqual(keys); // made once, then kept
      const header = await vapidAuth(browser.sub.endpoint, keys, "https://atlas.example.workers.dev");
      const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
      expect(k).toBe(keys.public);
      const [h, c, sig] = jwt!.split(".");
      const pub = await crypto.subtle.importKey("raw", fromB64url(keys.public), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(sig!), enc.encode(`${h}.${c}`));
      expect(valid).toBe(true);
      const claims = JSON.parse(new TextDecoder().decode(fromB64url(c!))) as { aud: string; exp: number; sub: string };
      expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://atlas.example.workers.dev" });
      expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    }));

  it("sends one push, to the device used last, when no app is in view", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      const laptop = await fakeBrowser();
      setState(sql, "push_devices", [device("laptop", laptop.sub, 1_000), device("phone", phone.sub, 2_000)]);
      const net = fakeNet();
      const { box, shown } = outbox(sql, net.f);
      await box.deliver({ text: "Your job finished.", run_id: null, channel: "app", urgency: "soon" }, { alreadyStreamed: false });

      expect(net.calls.map((c) => c.url)).toEqual([phone.sub.endpoint]);
      const headers = net.calls[0]!.init.headers as Record<string, string>;
      expect(headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "normal" });
      expect(await phone.decrypt(net.calls[0]!.init.body as Uint8Array)).toMatchObject({ title: "Atlas", body: "Your job finished." });
      expect(receipts(shown)).toEqual([expect.objectContaining({ channel: "push", to: "Phone phone", ok: true })]);
    }));

  it("doesn't push when the app is in view, in a call, or turned off", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      const net = fakeNet();
      await outbox(sql, net.f, { looking: true }).box.deliver({ text: "a", run_id: null, channel: "app" }, { alreadyStreamed: false });
      await outbox(sql, net.f, { inCall: true }).box.deliver({ text: "b", run_id: null, channel: "app" }, { alreadyStreamed: false });
      writeSettings(sql, {
        notifications: { push: false, quiet: readSettings(sql).notifications.quiet, budget: 10, lists: { now: ["push"], soon: ["push"] } },
      });
      await outbox(sql, net.f).box.deliver({ text: "c", run_id: null, channel: "app" }, { alreadyStreamed: false });
      expect(net.calls).toEqual([]);
    }));

  it("holds what can wait through quiet hours, and lets what can't through", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      // Quiet hours around now, in UTC.
      const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
      writeSettings(sql, {
        timezone: "UTC",
        notifications: {
          push: true,
          quiet: { on: true, from: hhmm(Date.now() - 3_600_000), to: hhmm(Date.now() + 3_600_000) },
          budget: 10,
          lists: { now: ["push"], soon: ["push"] },
        },
      });
      const net = fakeNet();
      const { box, held, shown } = outbox(sql, net.f);
      await box.deliver({ text: "Your job finished.", run_id: null, channel: "app", urgency: "soon" }, { alreadyStreamed: false });
      expect(net.calls).toEqual([]);
      expect(held).toHaveLength(1);
      expect(Math.abs(held[0]!.at.getTime() - (Date.now() + 3_600_000))).toBeLessThan(61_000);
      expect(receipts(shown)[0]).toMatchObject({ channel: "push", ok: true, held_until: held[0]!.at.getTime() });

      await box.deliver({ text: "Stretch now.", run_id: null, channel: "app", urgency: "now" }, { alreadyStreamed: false });
      expect(net.calls).toHaveLength(1);
      expect((net.calls[0]!.init.headers as Record<string, string>).urgency).toBe("high");
    }));

  it("forgets a device the push service says is gone, says why, and tries the next", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      const laptop = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 2), device("laptop", laptop.sub, 1)]);
      const net = fakeNet((url) =>
        url === phone.sub.endpoint
          ? new Response("push subscription has unsubscribed or expired.", { status: 410 })
          : new Response(null, { status: 201 }),
      );
      const { box, shown } = outbox(sql, net.f);
      await box.deliver({ text: "hi", run_id: null, channel: "app" }, { alreadyStreamed: false });
      expect(net.calls.map((c) => c.url)).toEqual([phone.sub.endpoint, laptop.sub.endpoint]);
      expect(pushDevices(sql).map((d) => d.id)).toEqual(["laptop"]);
      expect(receipts(shown)).toEqual([
        expect.objectContaining({
          to: "Phone phone",
          ok: false,
          error:
            "fcm.googleapis.com answered 410: push subscription has unsubscribed or expired.. That device stopped taking notifications, so Atlas forgot it.",
        }),
        expect.objectContaining({ to: "Phone laptop", ok: true }),
      ]);
    }));
});

describe("focus and the budget", () => {
  it("focus holds what can wait until it ends, and ending it early lets it out", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      const scheduled: string[] = [];
      const clock = { schedule: async (i: { id: string }) => void scheduled.push(i.id), unschedule: async () => {} };
      await setFocus(sql, clock, 45, "the quote", "owner");
      const net = fakeNet();
      const { box, held, shown } = outbox(sql, net.f);
      await box.deliver({ text: "Your job finished.", run_id: null, channel: "app", urgency: "soon" }, { alreadyStreamed: false });
      await box.deliver({ text: "Call the landlord.", run_id: null, channel: "app", urgency: "now" }, { alreadyStreamed: false });
      expect(net.calls).toHaveLength(1);
      expect(held).toHaveLength(1);
      expect(String(receipts(shown)[0]!.note)).toContain("Held for focus (the quote)");
      // The agent's hold puts it on the clock; ending focus brings that item forward.
      const item = createItem(sql, {
        kind: "notify",
        title: "Your job finished.",
        due_at: held[0]!.at.getTime(),
        source: { via: "outbox" },
      });
      await setFocus(sql, clock, 0, "", "owner");
      expect(scheduled).toEqual([item.id]);
    }));

  it("past the day's budget, what can wait stays in the app", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      writeSettings(sql, { notifications: { ...readSettings(sql).notifications, budget: 2 } });
      const net = fakeNet();
      const { box, shown } = outbox(sql, net.f);
      for (const text of ["one", "two", "three"])
        await box.deliver({ text, run_id: null, channel: "app", urgency: "soon" }, { alreadyStreamed: false });
      await box.deliver({ text: "A reminder you set.", run_id: null, channel: "app", urgency: "now" }, { alreadyStreamed: false });
      expect(net.calls).toHaveLength(3);
      expect(receipts(shown).map((r) => r.note ?? r.urgency)).toEqual([
        "soon",
        "soon",
        "Not sent: today's 2 interruptions are used. It waits in the app.",
        "now",
      ]);
    }));
});

describe("quiet hours", () => {
  const at = (iso: string) => new Date(iso);
  const quiet = { on: true, from: "22:00", to: "07:00" };
  it("end the next morning when they run past midnight", () => {
    expect(quietUntil(at("2026-10-22T23:30:00-04:00"), "America/New_York", quiet)?.toISOString()).toBe("2026-10-23T11:00:00.000Z");
    expect(quietUntil(at("2026-10-23T03:00:00-04:00"), "America/New_York", quiet)?.toISOString()).toBe("2026-10-23T11:00:00.000Z");
    expect(quietUntil(at("2026-10-23T12:00:00-04:00"), "America/New_York", quiet)).toBeNull();
    expect(quietUntil(at("2026-10-23T03:00:00-04:00"), "America/New_York", { ...quiet, on: false })).toBeNull();
  });
  it("work within one day too", () => {
    const nap = { on: true, from: "13:00", to: "14:30" };
    expect(quietUntil(at("2026-10-23T13:10:00Z"), "UTC", nap)?.toISOString()).toBe("2026-10-23T14:30:00.000Z");
    expect(quietUntil(at("2026-10-23T14:30:00Z"), "UTC", nap)).toBeNull();
  });
});

describe("held notifications on the clock", () => {
  it("go out together, as one push, when quiet hours end", async () => {
    const phone = await fakeBrowser();
    const net = fakeNet();
    seams.fetch = net.f;
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`held-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      const ids = ["First thing.", "Second thing."].map((text) => {
        const row = append(sql, { actor: "atlas", kind: "message.out", surface: "app", body: { text } });
        return createItem(sql, { kind: "notify", title: text, due_at: Date.now() - 1000, source: { log_id: row.id, via: "outbox" } }).id;
      });
      await agent.onAgendaDue({ id: ids[0]! });
      await agent.onAgendaDue({ id: ids[1]! });
    });
    expect(net.calls).toHaveLength(1);
    expect(await phone.decrypt(net.calls[0]!.init.body as Uint8Array)).toMatchObject({ body: "2 messages. The first: First thing." });
  });
});

describe("where a message goes (§14)", () => {
  /** An outbox with a Telegram the owner linked, and a follow-up clock. */
  function reaching(sql: Sql, f: typeof fetch, o: { linked?: string[] } = {}) {
    const chats: Array<{ ext: string; text: string }> = [];
    const follow: Array<{ at: Date; rest: string[] }> = [];
    const shown: LogRow[] = [];
    const channels: Channels = {
      broadcast: (rows) => shown.push(...rows),
      speak: async () => false,
      looking: () => false,
      hold: async () => {},
      followUp: async (at, _n, rest) => void follow.push({ at, rest }),
      fetch: f,
      browser: () => null,
      mcp: () => null,
      chat: async (ext, text) => {
        if (!(o.linked ?? ["telegram"]).includes(ext)) return false;
        chats.push({ ext, text });
        return true;
      },
    };
    return { box: new Outbox(sql, channels), chats, follow, shown };
  }
  const lists = (now: string[], soon: string[]) => ({ ...Settings.parse({}).notifications, lists: { now, soon } });
  const ownerSaid = (sql: Sql, o: { channel?: string; at?: number; run?: string } = {}) => {
    const row = append(sql, {
      actor: "owner",
      kind: "message.in",
      surface: o.channel ? "chat" : "app",
      ...(o.run ? { run_id: o.run } : {}),
      body: { text: "hi", ...(o.channel ? { channel: o.channel } : {}) },
    });
    if (o.at) sql.exec(`UPDATE log SET at = ? WHERE id = ?`, o.at, row.id);
  };

  it("keeps where settings saved before the lists reached the owner, with a push behind a chat", () => {
    expect(Settings.parse({ notifications: { push: true, budget: 10, reach: "telegram" } }).notifications.lists).toEqual({
      now: ["telegram", "push"],
      soon: ["telegram", "push"],
    });
    expect(Settings.parse({ notifications: { reach: "push" } }).notifications.lists).toEqual({ now: ["push"], soon: ["push"] });
  });

  it("tries the chat the owner is writing on, then where the matter started, then their list", () =>
    withSql((sql) => {
      writeSettings(sql, { notifications: lists(["push"], ["push"]) });
      expect(route(sql, "soon")).toEqual(["push"]);
      expect(route(sql, "soon", "discord")).toEqual(["discord", "push"]);
      ownerSaid(sql, { channel: "telegram" });
      expect(route(sql, "now", "discord")).toEqual(["telegram", "discord", "push"]);
      // Said a while ago, or last in the app: not talking there now.
      ownerSaid(sql, { channel: "telegram", at: Date.now() - 30 * 60_000 });
      ownerSaid(sql, {});
      expect(route(sql, "now")).toEqual(["push"]);
    }));

  it("finds where a job or a promise was asked for, from the run that made it", () =>
    withSql((sql) => {
      ownerSaid(sql, { channel: "telegram", run: "run_asked" });
      const job = createItem(sql, {
        kind: "job",
        title: "Find flights",
        due_at: Date.now() + 60_000,
        source: { run_id: "run_asked", via: "helpers" },
      });
      expect(askedOn(sql, `job:${job.id}`)).toBe("telegram");
      expect(askedOn(sql, "device:mac")).toBeNull();
    }));

  it("sends to the place an automation names, and the usual way when that place can't take it", () =>
    withSql(async (sql) => {
      writeSettings(sql, { notifications: lists(["push"], ["push"]) });
      const { box, chats, shown } = reaching(sql, fakeNet().f, { linked: ["telegram"] });
      await box.deliver({ text: "Your brief.", run_id: null, channel: "app", to: "telegram" }, { alreadyStreamed: false });
      expect(chats).toEqual([{ ext: "telegram", text: "Your brief." }]);
      expect(receipts(shown)).toEqual([expect.objectContaining({ channel: "chat", to: "telegram", ok: true })]);
      // Discord isn't linked: it says so, and the owner's list takes it from there.
      shown.length = 0;
      await box.deliver({ text: "Another.", run_id: null, channel: "app", to: "discord" }, { alreadyStreamed: false });
      expect(chats).toHaveLength(1);
      expect(receipts(shown)[0]).toMatchObject({ ok: false, note: "That chat didn't take it, so it went the usual way." });
    }));

  it("sends something now to the first place, and puts the next on the clock in case it isn't seen", () =>
    withSql(async (sql) => {
      writeSettings(sql, { notifications: lists(["telegram", "push"], ["push"]) });
      const { box, chats, follow, shown } = reaching(sql, fakeNet().f);
      await box.deliver({ text: "Your flight moved to 6:40.", run_id: null, channel: "app", urgency: "now" }, { alreadyStreamed: false });
      expect(chats).toEqual([{ ext: "telegram", text: "Your flight moved to 6:40." }]);
      expect(follow).toHaveLength(1);
      expect(follow[0]!.rest).toEqual(["push"]);
      expect(Math.abs(follow[0]!.at.getTime() - (Date.now() + FOLLOW_UP_MS))).toBeLessThan(5_000);
      expect(receipts(shown)).toEqual([expect.objectContaining({ channel: "chat", to: "telegram", ok: true, urgency: "now" })]);
    }));

  it("sends something soon to the first place that takes it, with no follow-up, and keeps something later in the app", () =>
    withSql(async (sql) => {
      const phone = await fakeBrowser();
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      writeSettings(sql, { notifications: lists(["push"], ["discord", "push"]) });
      const net = fakeNet();
      const { box, chats, follow, shown } = reaching(sql, net.f);
      await box.deliver({ text: "Oat milk on the way home?", run_id: null, channel: "app", urgency: "soon" }, { alreadyStreamed: false });
      // Discord isn't linked, so the push takes it.
      expect(chats).toEqual([]);
      expect(net.calls).toHaveLength(1);
      expect(follow).toEqual([]);
      await box.deliver({ text: "A new episode is out.", run_id: null, channel: "app", urgency: "later" }, { alreadyStreamed: false });
      expect(net.calls).toHaveLength(1);
      expect(receipts(shown).at(-1)).toMatchObject({
        channel: "app",
        urgency: "later",
        note: "It waits in the app, for when you next open it.",
      });
    }));

  it("moves something unseen down the list when its follow-up comes due, and lets it be once the owner has seen it", async () => {
    const phone = await fakeBrowser();
    const net = fakeNet();
    seams.fetch = net.f;
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`follow-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      setState(sql, "push_devices", [device("phone", phone.sub, 1)]);
      const sent = Date.now() - FOLLOW_UP_MS;
      const follow = (text: string) => {
        const row = append(sql, { actor: "atlas", kind: "message.out", surface: "app", body: { text } });
        return createItem(sql, {
          kind: "follow_up",
          title: text,
          due_at: Date.now() - 1000,
          source: { log_id: row.id, via: "outbox", detail: { rest: ["push"], sent_at: sent } },
        }).id;
      };
      await agent.onAgendaDue({ id: follow("Leave now for the dentist.") });
      expect(net.calls).toHaveLength(1);
      setState(sql, "owner_seen_at", Date.now());
      await agent.onAgendaDue({ id: follow("The gate changed to B12.") });
      expect(net.calls).toHaveLength(1);
    });
    expect(await phone.decrypt(net.calls[0]!.init.body as Uint8Array)).toMatchObject({ body: "Leave now for the dentist." });
  });
});
