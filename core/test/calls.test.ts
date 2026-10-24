// Phone calls (VISION §16.1): the audio bridge between a phone's media stream
// and Atlas's voice, Telnyx's numbers moved one at a time and given back, a
// call answered only for the owner's own vouched-for number, and a call to
// the owner as the last place for something that can't wait.

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { getExt, install, setExtSecrets, uninstall } from "../src/extensions";
import { Outbox, type Channels } from "../src/outbox";
import { ownerRecord } from "../src/store/records";
import { Settings, writeSettings } from "../src/store/settings";
import { setState } from "../src/store/state";
import { bridge, type End, linearToUlaw, phoneToSpeechIn, speechToPhone, ulawToLinear } from "../src/voice/phone";
import { fakeCalendar, fakeEmbedder, runExtensionsHere } from "./helpers";
import { connect, inOwner } from "./owner";

describe("the phone's audio", () => {
  it("goes through μ-law and back within its step", () => {
    for (const s of [0, 1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) {
      const back = ulawToLinear(linearToUlaw(s));
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.07));
    }
  });

  it("is widened from 8 kHz to the 16 kHz speech-in takes, and Atlas's 24 kHz speech narrowed to 8 kHz", () => {
    const ulaw = new Uint8Array(160).fill(linearToUlaw(1000));
    const { pcm } = phoneToSpeechIn(ulaw, 1000);
    expect(pcm.byteLength).toBe(160 * 2 * 2);
    expect(new Int16Array(pcm)[5]).toBeCloseTo(ulawToLinear(linearToUlaw(1000)), -1);

    const speech = new Int16Array(481).fill(2000);
    const out = speechToPhone(new Uint8Array(speech.buffer), 24_000);
    expect(out.ulaw.length).toBe(160);
    expect(out.carry.length).toBe(2); // the part sample waits for the next piece
    expect(Math.abs(ulawToLinear(out.ulaw[0]!) - 2000)).toBeLessThan(100);
  });
});

/** One end of a socket, recording what's sent to it and letting the test deliver to it. */
function end() {
  const sent: Array<string | ArrayBuffer> = [];
  const fns: Record<string, Array<(e: { data: unknown }) => void>> = {};
  let closed = false;
  const e: End & { sent: typeof sent; deliver(d: unknown): void; hangUp(): void; closed(): boolean } = {
    sent,
    send: (d) => void sent.push(d),
    close: () => {
      closed = true;
    },
    addEventListener: (type: string, fn: (e: { data: unknown }) => void) => void (fns[type] ??= []).push(fn),
    deliver: (d) => fns.message?.forEach((f) => f({ data: d })),
    hangUp: () => fns.close?.forEach((f) => f({ data: null })),
    closed: () => closed,
  };
  return e;
}

describe("the bridge", () => {
  it("starts the call with the stream, carries both ways in whole frames, clears the phone when Atlas is cut off, and ends with it", () => {
    const phone = end();
    const agent = end();
    const ended: string[] = [];
    bridge(phone, agent, { rate: 24_000, onEnd: (w) => ended.push(w) });
    phone.deliver(JSON.stringify({ event: "connected" }));
    phone.deliver(JSON.stringify({ event: "start", start: { call_control_id: "c1" } }));
    expect(agent.sent).toEqual([JSON.stringify({ type: "start_call" })]);

    const payload = btoa(String.fromCharCode(...new Uint8Array(160).fill(0xff)));
    phone.deliver(JSON.stringify({ event: "media", media: { track: "inbound", payload } }));
    expect((agent.sent[1] as ArrayBuffer).byteLength).toBe(640);

    // 30 ms of speech: one 20 ms frame now, the rest with the next piece.
    agent.deliver(new Int16Array(720).buffer);
    const frame = JSON.parse(phone.sent[0] as string) as { event: string; media: { payload: string } };
    expect(frame.event).toBe("media");
    expect(atob(frame.media.payload).length).toBe(160);
    agent.deliver(new Int16Array(240).buffer);
    expect(atob((JSON.parse(phone.sent[1] as string) as typeof frame).media.payload).length).toBe(160);

    agent.deliver(JSON.stringify({ type: "playback_interrupt" }));
    expect(JSON.parse(phone.sent[2] as string)).toEqual({ event: "clear" });

    phone.deliver(JSON.stringify({ event: "stop" }));
    expect(agent.sent.at(-1)).toBe(JSON.stringify({ type: "end_call" }));
    expect(phone.closed() && agent.closed()).toBe(true);
    expect(ended).toEqual(["the call ended"]);
  });
});

// --- Telnyx --------------------------------------------------------------------------------

interface Req {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** A fake Telnyx: two numbers, one on another app, and a record of every request. */
function fakeTelnyx() {
  const reqs: Req[] = [];
  const numbers = [
    { id: "n1", phone_number: "+15550100001", status: "active", connection_id: "conn_old", connection_name: "Office PBX" },
    { id: "n2", phone_number: "+15550100002", status: "active", connection_id: null, connection_name: null },
  ];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.telnyx.com") return new Response("ok");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = u.pathname.replace(/^\/v2/, "");
    reqs.push({ method, path: `${path}${u.search}`, body });
    if ((init.headers as Headers).get?.("authorization") !== "Bearer KEY_test_123")
      return Response.json({ errors: [{ code: "10009", title: "Authentication failed" }] }, { status: 401 });
    if (method === "GET" && path === "/phone_numbers") return Response.json({ data: numbers, meta: { total_results: 2 } });
    const one = /^\/phone_numbers\/(\w+)$/.exec(path);
    if (one && method === "GET") return Response.json({ data: numbers.find((n) => n.id === one[1]) });
    if (one && method === "PATCH") {
      const n = numbers.find((x) => x.id === one[1])!;
      n.connection_id = (body.connection_id as string | null) ?? null;
      return Response.json({ data: n });
    }
    if (method === "POST" && path === "/outbound_voice_profiles") return Response.json({ data: { id: "ovp_1" } }, { status: 201 });
    if (method === "POST" && path === "/call_control_applications") return Response.json({ data: { id: "app_atlas" } }, { status: 201 });
    if (method === "PATCH" && path.startsWith("/call_control_applications/")) return Response.json({ data: { id: "app_atlas" } });
    if (method === "POST" && path === "/calls") return Response.json({ data: { call_control_id: "out_1" } });
    if (method === "POST" && path.startsWith("/calls/")) return Response.json({ data: { result: "ok" } });
    if (method === "GET" && path === "/available_phone_numbers")
      return Response.json({
        data: [
          {
            phone_number: "+15125550123",
            region_information: [
              { region_type: "rate_center", region_name: "AUSTIN" },
              { region_type: "state", region_name: "TX" },
            ],
            cost_information: { monthly_cost: "1.00", upfront_cost: "1.00", currency: "USD" },
          },
        ],
      });
    return Response.json({ errors: [{ code: "10005", title: "Not found" }] }, { status: 404 });
  }) as unknown as typeof fetch;
  return { f, reqs, numbers };
}

let tx = fakeTelnyx();
let key = "";

beforeEach(async () => {
  tx = fakeTelnyx();
  seams.fetch = tx.f;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  runExtensionsHere();
  await inOwner((_a, sql) => {
    uninstall(sql, "telnyx");
    install(sql, { id: "telnyx", source: "bundled", state: "on" });
    setExtSecrets(sql, "telnyx", { api_key: "KEY_test_123" });
    setState(sql, "origin", "https://atlas.test");
    // A number on the owner's record isn't enough: what Atlas reads can add to it. Their own numbers are set by them.
    const owner = ownerRecord(sql);
    sql.exec(`UPDATE records SET fields = json_set(fields, '$.phone', ?) WHERE id = ?`, "+1 (555) 010-7777", owner.id);
    writeSettings(sql, { phone: { mine: ["+1 (555) 010-9999"] } });
    setState(sql, "calls_placed", null);
    setState(sql, "call_tokens", null);
    key = getExt(sql, "telnyx")!.key;
  });
});

afterEach(() => {
  seams.fetch = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

const post = (body: unknown) =>
  SELF.fetch(`https://atlas.test/x/telnyx/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const initiated = (from: string, attest: { a: string; ok: boolean }) => ({
  data: {
    id: crypto.randomUUID(),
    event_type: "call.initiated",
    payload: {
      call_control_id: "call_in_1",
      direction: "incoming",
      from,
      to: "+15550100001",
      shaken_stir_attestation: attest.a,
      shaken_stir_validated: attest.ok,
    },
  },
});

describe("Telnyx", () => {
  it("lists the account's numbers, moves only the one picked to Atlas, and gives it back to where it was", async () => {
    const s = await connect();
    s.send({ type: "atlas.calls.numbers" });
    const listed = await s.next("atlas.calls");
    expect(listed.numbers).toEqual([
      { id: "n1", number: "+15550100001", connected: "Office PBX", ours: false, status: "active" },
      { id: "n2", number: "+15550100002", connected: null, ours: false, status: "active" },
    ]);

    s.send({ type: "atlas.calls.use", id: "n1" });
    const used = await s.next("atlas.calls");
    expect(used.text).toContain("Atlas answers +15550100001 now");
    expect(used.text).toContain("Office PBX");
    expect(used.number).toBe("+15550100001");
    expect(tx.reqs.find((r) => r.path === "/call_control_applications")!.body).toMatchObject({
      webhook_event_url: `https://atlas.test/x/telnyx/${key}`,
      webhook_api_version: "2",
      outbound: { outbound_voice_profile_id: "ovp_1" },
    });
    expect(tx.reqs.find((r) => r.path === "/outbound_voice_profiles")!.body).toMatchObject({ daily_spend_limit_enabled: true });
    expect(tx.numbers.map((n) => n.connection_id)).toEqual(["app_atlas", null]);

    s.send({ type: "atlas.calls.release" });
    expect((await s.next("atlas.calls")).text).toContain("Gave +15550100001 back");
    expect(tx.numbers[0]!.connection_id).toBe("conn_old");
  });

  it("shows numbers it would sell with their price", async () => {
    const s = await connect();
    s.send({ type: "atlas.calls.available", area: "512" });
    const out = await s.next("atlas.calls");
    expect(out.offers).toEqual([{ number: "+15125550123", where: "AUSTIN, TX", monthly: "1.00", upfront: "1.00", currency: "USD" }]);
    expect(tx.reqs.at(-1)!.path).toContain("filter%5Bnational_destination_code%5D=512");
  });

  it("answers the owner's own number into Atlas's voice only when the network vouches for it, and anyone else hears whose assistant this is", async () => {
    const s = await connect();
    s.send({ type: "atlas.calls.use", id: "n1" });
    await s.next("atlas.calls");

    expect((await post(initiated("+15550109999", { a: "A", ok: true }))).status).toBe(200);
    const answer = tx.reqs.find((r) => r.path === "/calls/call_in_1/actions/answer")!;
    expect(String(answer.body.stream_url)).toMatch(
      new RegExp(`^wss://atlas\\.test/x/telnyx/${key}/stream/[0-9a-f]{32}\\?call=in-call_in_1$`),
    );
    // The number on the owner's record, not one they set as theirs, isn't the owner.
    tx.reqs.length = 0;
    await post(initiated("+15550107777", { a: "A", ok: true }));
    expect(tx.reqs.find((r) => r.path === "/calls/call_in_1/actions/answer")!.body.stream_url).toBeUndefined();
    // An anonymous caller's empty ID matches nobody.
    tx.reqs.length = 0;
    await post(initiated("anonymous", { a: "A", ok: true }));
    expect(tx.reqs.find((r) => r.path === "/calls/call_in_1/actions/answer")!.body.stream_url).toBeUndefined();
    expect(answer.body).toMatchObject({
      stream_bidirectional_mode: "rtp",
      stream_codec: "PCMU",
    });

    // The same number with caller ID the network couldn't check isn't the owner.
    tx.reqs.length = 0;
    await post(initiated("+15550109999", { a: "C", ok: false }));
    const other = tx.reqs.find((r) => r.path === "/calls/call_in_1/actions/answer")!;
    expect(other.body.stream_url).toBeUndefined();
    const state = other.body.client_state as string;
    await post({ data: { id: "e2", event_type: "call.answered", payload: { call_control_id: "call_in_1", client_state: state } } });
    expect(tx.reqs.find((r) => r.path === "/calls/call_in_1/actions/speak")!.body.payload).toMatch(/assistant\. .* doesn't take calls/);
  });

  it("refuses a stream that isn't at its extension's address", async () => {
    const token = "a".repeat(32);
    const wrongKey = await SELF.fetch(`https://atlas.test/x/telnyx/${"0".repeat(36)}/stream/${token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(wrongKey.status).toBe(401);
    // The address's own key isn't enough either: a stream needs a one-time key from a call Atlas answered or placed.
    const noCall = await SELF.fetch(`https://atlas.test/x/telnyx/${key}/stream/${token}`, { headers: { upgrade: "websocket" } });
    expect(noCall.status).toBe(401);
  });

  it("calls the owner for something that can't wait, last on their list, once they've allowed calls", async () => {
    const s = await connect();
    s.send({ type: "atlas.calls.use", id: "n1" });
    await s.next("atlas.calls");
    await inOwner(async (agent, sql) => {
      void agent;
      const base = Settings.parse({});
      writeSettings(sql, { notifications: { ...base.notifications, lists: { now: ["call"], soon: ["push"] } } });
      const shown: unknown[] = [];
      const channels = (allowed: boolean): Channels => ({
        broadcast: (rows) => void shown.push(...rows),
        speak: async () => false,
        looking: () => false,
        hold: async () => {},
        fetch: tx.f,
        browser: () => null,
        mcp: () => null,
        call: async () => allowed,
      });
      await new Outbox(sql, channels(true)).deliver(
        { text: "Your flight is boarding.", run_id: null, channel: "app", urgency: "soon" },
        { alreadyStreamed: false },
      );
      // Something soon never calls.
      expect(shown.filter((r) => (r as { kind: string }).kind === "delivery")).toEqual([]);
      await new Outbox(sql, channels(true)).deliver(
        { text: "Your flight is boarding now.", run_id: null, channel: "app", urgency: "now" },
        { alreadyStreamed: false },
      );
      expect(shown.filter((r) => (r as { kind: string }).kind === "delivery").map((r) => (r as { body: unknown }).body)).toEqual([
        expect.objectContaining({ channel: "call", ok: true, urgency: "now" }),
      ]);
      writeSettings(sql, { notifications: base.notifications });
    });
    // Settings' test call rings the owner from Atlas's number, its stream marked as a call Atlas placed.
    s.send({ type: "atlas.calls.test" });
    const test = await s.next("atlas.calls");
    expect(test.text).toBe("Calling you now.");
    const dial = tx.reqs.find((r) => r.path === "/calls")!;
    expect(dial.body).toMatchObject({
      connection_id: "app_atlas",
      to: "+1 (555) 010-9999",
      from: "+15550100001",
      stream_establish_before_call_originate: true,
    });
    expect(String(dial.body.stream_url)).toMatch(new RegExp(`^wss://atlas\\.test/x/telnyx/${key}/stream/[0-9a-f]{32}\\?call=out-`));
    // At most a few calls an hour, whatever the reason.
    for (let i = 1; i < 4; i++) {
      s.send({ type: "atlas.calls.test" });
      expect((await s.next("atlas.calls")).ok).toBe(true);
    }
    s.send({ type: "atlas.calls.test" });
    const capped = await s.next("atlas.calls");
    expect(capped.ok).toBe(false);
    expect(capped.text).toContain("4 times in the last hour");
  });
});
