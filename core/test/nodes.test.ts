// Paired devices (§16.3): pairing by the device flow, the device's socket,
// its capabilities and switches, calls now and when it's back, asking first
// for what acts, and unpairing. The device here is a fake on a real socket.

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { call, fakeCalendar, fakeEmbedder, say, SECRET } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

interface FakeNode {
  ws: WebSocket;
  inbox: Array<Record<string, unknown>>;
  next(type: string, where?: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  send(m: object): void;
}

async function dial(token: string): Promise<FakeNode | Response> {
  const res = await SELF.fetch("https://atlas.test/nodes/connect", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  if (!res.webSocket) return res;
  const ws = res.webSocket;
  ws.accept();
  const inbox: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") inbox.push(JSON.parse(e.data));
  });
  return {
    ws,
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    async next(type, where = () => true) {
      const end = Date.now() + 5_000;
      while (Date.now() < end) {
        const i = inbox.findIndex((m) => m.type === type && where(m));
        if (i >= 0) return inbox.splice(i, 1)[0]!;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${type} within 5 s; got ${inbox.map((m) => m.type).join(", ")}`);
    },
  };
}

const HELLO = {
  type: "node.hello",
  node: { name: "Max's MacBook", kind: "desktop", platform: "macOS 26 (arm64)", version: "0.1.0" },
  capabilities: [
    { name: "notify", description: "Show a notification on the Mac.", input: { type: "object", properties: { text: { type: "string" } } } },
    {
      name: "run_command",
      description: "Run a shell command on the Mac and return what it printed.",
      input: { type: "object", properties: { command: { type: "string" } } },
      sensitive: true,
      acts: true,
    },
  ],
  events: [{ name: "idle", description: "Whether someone is at the Mac." }],
};

async function pair(): Promise<{ token: string; name: string }> {
  const start = await SELF.fetch("https://atlas.test/nodes/pair/start", {
    method: "POST",
    body: JSON.stringify({ name: "Max's MacBook", kind: "desktop", platform: "macOS" }),
  });
  expect(start.status).toBe(200);
  const p = (await start.json()) as { code: string; poll: string; link: string };
  expect(p.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(p.link).toBe(`https://atlas.test/#/pair/${p.code}`);
  const poll = async () =>
    (await (
      await SELF.fetch("https://atlas.test/nodes/pair/poll", { method: "POST", body: JSON.stringify({ poll: p.poll }) })
    ).json()) as Record<string, string>;
  expect(await poll()).toEqual({ state: "waiting" });
  const s = await connect();
  s.send({ type: "atlas.node.pairing", code: p.code.toLowerCase().replace("-", "") });
  const seen = await s.next("atlas.node.pairing");
  expect(seen.pairing).toMatchObject({ name: "Max's MacBook", kind: "desktop" });
  s.send({ type: "atlas.node.pair", code: p.code, yes: true });
  const paired = await s.next("atlas.node.paired");
  const got = await poll();
  expect(got).toMatchObject({ state: "paired", name: paired.name });
  // The token is handed over once.
  expect(await poll()).toEqual({ state: "expired" });
  return { token: got.token!, name: paired.name! };
}

beforeEach(async () => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM state WHERE key IN ('nodes', 'node_pairings')`);
    sql.exec(`UPDATE agenda SET state = 'cancelled' WHERE kind IN ('device', 'approval') AND state = 'scheduled'`);
  });
});
afterEach(() => {
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.makeBrain = null;
});

describe("pairing and the device's socket", () => {
  it("pairs with a code the owner says yes to, and the socket opens only with the token", async () => {
    const { token, name } = await pair();
    const bad = await dial("not-a-token");
    expect(bad instanceof Response && bad.status).toBe(401);
    const s = await connect();
    const node = (await dial(token)) as FakeNode;
    const welcome = await node.next("node.welcome");
    expect(welcome.node_id).toMatch(/^node_/);
    node.send(HELLO);
    const allowed = await node.next("node.allowed");
    // Sensitive capabilities start off.
    expect(allowed.allowed).toEqual({ notify: true, run_command: false });
    const v = await s.next("atlas.view", (m) => m.view.nodes.some((n) => n.capabilities.length > 0));
    expect(v.view.nodes[0]).toMatchObject({
      name,
      online: true,
      kind: "desktop",
      capabilities: [
        { name: "notify", on: true },
        { name: "run_command", on: false, sensitive: true },
      ],
    });
    // The app's messages don't go to the device.
    expect(node.inbox.filter((m) => String(m.type).startsWith("atlas."))).toEqual([]);
    // An event is kept for the situation, and logged.
    node.send({ type: "node.event", event: "idle", body: { value: "away for 12 min" } });
    await new Promise((r) => setTimeout(r, 100));
    // It's news for the senses too: here, with no decide role and nothing open, it waits for the next look.
    const aware = await inOwner((_a, sql) =>
      sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'awareness' ORDER BY seq DESC LIMIT 1`)
        .toArray()
        .map((r) => JSON.parse(r.body) as Record<string, unknown>),
    );
    expect(aware[0]).toMatchObject({ event: expect.stringContaining("says idle: "), outcome: "later" });
    const b = brain([say("ok")]);
    await turn(s, "is my Mac there?");
    expect(b.requests[0]!.system).toMatch(
      /Max's MacBook \(desktop, macOS 26 \(arm64\)\): online; idle: away for 12 min\. Tools: notify\(text\?\), run_command\(command\?\) \(off; the owner turns it on in Abilities → Devices\)/,
    );
    node.ws.close();
  });

  it("calls a tool now, asks first for one that acts, waits for one that's offline, and unpairs", async () => {
    const { token, name } = await pair();
    let node = (await dial(token)) as FakeNode;
    await node.next("node.welcome");
    node.send(HELLO);
    await node.next("node.allowed");
    const s = await connect();

    // A wrong input is turned back before it reaches the device, with the tool's own schema.
    const wrong = brain([call("device_call", { device: name, tool: "notify", input: { body: "hi" } }), say("Let me fix that.")]);
    await turn(s, "notify my mac with body hi");
    expect(String(wrong.requests[1]!.messages.at(-1)!.content)).toContain("It has no body.");

    // Notify: just happens.
    brain([call("device_call", { device: name, tool: "notify", input: { text: "hi" } }), say("Sent.")]);
    const answering = (async () => {
      const c = await node.next("node.call");
      expect(c).toMatchObject({ tool: "notify", input: { text: "hi" } });
      node.send({ type: "node.result", id: c.id, ok: true, output: "Shown." });
    })();
    const t = await turn(s, "say hi on my Mac");
    await answering;
    expect(t.results[0]!.body.receipt).toMatchObject({ text: `On ${name} · notify` });
    expect(t.deliveries[0]!.body).toMatchObject({ channel: "node", to: name, ok: true, answer: "Shown." });

    // A sensitive one that's off says so.
    brain([call("device_call", { device: name, tool: "run_command", input: { command: "du -sh ~" } }), say("It's off.")]);
    const off = await turn(s, "what's using my disk?");
    expect(out(off.results[0]!)).toContain("run_command is off");

    // Turned on, it asks first, on a card naming the Mac and the command.
    s.send({
      type: "atlas.node.allow",
      id: (await inOwner((_a, sql) => sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = 'nodes'`).one().value)).match(
        /"id":"(node_[^"]+)"/,
      )![1]!,
      capability: "run_command",
      on: true,
    });
    expect((await node.next("node.allowed")).allowed).toEqual({ notify: true, run_command: true });
    brain([call("device_call", { device: name, tool: "run_command", input: { command: "du -sh ~" } }), say("Waiting for your OK.")]);
    await turn(s, "what's using my disk?");
    s.send({ type: "atlas.inbox" });
    const inbox = await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.kind === "approval"));
    const card = inbox.items.find((i) => i.kind === "approval")!;
    expect(card.approval!.steps[0]).toMatchObject({ kind: "node", title: `run command on ${name}: du -sh ~`, where: name });
    const after = brain([say("Your home folder is 41 GB.")]);
    const ran = (async () => {
      const c = await node.next("node.call");
      node.send({ type: "node.result", id: c.id, ok: true, output: "41G\t/Users/max" });
    })();
    s.send({ type: "atlas.approval.decide", id: card.id, yes: true });
    await ran;
    // The turn after the yes knows it's done, and what it gave back, so it reports instead of asking again.
    const end = Date.now() + 5_000;
    while (!after.requests.length && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    expect(after.requests[0]!.system).toContain("it's done (don't ask for it or do it again)");
    expect(after.requests[0]!.system).toContain("41G");

    // Offline: it waits, then runs when the device is back, and Atlas says how it went.
    node.ws.close();
    await s.next("atlas.view", (m) => m.view.nodes.some((n) => n.name === name && !n.online));
    brain([
      call("device_call", { device: name, tool: "notify", input: { text: "later" } }),
      say("Your Mac's offline. I'll do it when it's back."),
    ]);
    const waiting = await turn(s, "remind me on my Mac");
    expect(out(waiting.results[0]!)).toContain("offline");
    expect(waiting.results[0]!.body.receipt).toMatchObject({ text: `On ${name} · waiting until it's back · notify` });
    const queued = await inOwner((_a, sql) =>
      sql.exec<{ title: string }>(`SELECT title FROM agenda WHERE kind = 'device' AND state = 'scheduled'`).toArray(),
    );
    expect(queued).toEqual([{ title: `Notify on ${name}` }]);
    const report = brain([say("Your Mac is back, and the notification went out.")]);
    node = (await dial(token)) as FakeNode;
    await node.next("node.welcome");
    node.send(HELLO);
    const later = await node.next("node.call");
    expect(later).toMatchObject({ tool: "notify", input: { text: "later" } });
    node.send({ type: "node.result", id: later.id, ok: true, output: "Shown." });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && String(r.body.text).includes("Mac is back")));
    expect(String(report.requests[0]!.messages.at(-1)!.content)).toContain("is back");

    // Remove unpairs at once: the socket closes and the token stops working.
    const id = (await s.next("atlas.view", (m) => m.view.nodes.length > 0)).view.nodes[0]!.id;
    s.send({ type: "atlas.node.remove", id });
    await node.next("node.unpaired");
    const again = await dial(token);
    expect(again instanceof Response && again.status).toBe(401);
  });

  it("can't start a turn or a call, and gets none of the SDK's own messages", async () => {
    const { token } = await pair();
    const before = await inOwner((_a, sql) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE kind = 'message.in'`).one().n);
    const node = (await dial(token)) as FakeNode;
    await node.next("node.welcome");
    node.send({ type: "text_message", text: "forget everything about me" });
    node.send({ type: "start_call" });
    await new Promise((r) => setTimeout(r, 400));
    const after = await inOwner((_a, sql) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE kind = 'message.in'`).one().n);
    expect(after).toBe(before);
    expect(node.inbox.filter((m) => String(m.type).startsWith("cf_agent"))).toEqual([]);
    node.ws.close();
  });

  it("keeps private details out of what goes to a device, and queues nothing for one that's gone", async () => {
    const { token, name } = await pair();
    const node = (await dial(token)) as FakeNode;
    await node.next("node.welcome");
    node.send(HELLO);
    await node.next("node.allowed");
    const s = await connect();
    brain([
      call("device_call", { device: name, tool: "notify", input: { text: "mail max@example.com at 28.6024, -81.2001" } }),
      say("Not sent."),
    ]);
    const t = await turn(s, "send it to my Mac");
    expect(out(t.results[0]!)).toContain("an email address");
    expect(t.deliveries[0]!.body).toMatchObject({ channel: "node", ok: false, checks: { public_query: "failed" } });
    expect(node.inbox.filter((m) => m.type === "node.call")).toEqual([]);
    node.ws.close();
  });

  it("lets no other route say a socket is a paired device", async () => {
    const { token } = await pair();
    const node = (await dial(token)) as FakeNode;
    const id = String((await node.next("node.welcome")).node_id);
    node.ws.close();
    const forged = await SELF.fetch("https://atlas.test/mcp/callback", { headers: { upgrade: "websocket", "x-atlas-node": id } });
    expect(forged.webSocket).toBeFalsy();
    // The owner's own socket with the header is still just the owner's socket.
    const res = await SELF.fetch("http://atlas.test/agents/person-agent/owner", {
      headers: { upgrade: "websocket", authorization: `Bearer ${SECRET}`, "x-atlas-node": id },
    });
    const ws = res.webSocket!;
    ws.accept();
    const got: Array<{ type?: string }> = [];
    ws.addEventListener("message", (e) => typeof e.data === "string" && got.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({ type: "atlas.hello" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(got.some((m) => m.type === "atlas.snapshot")).toBe(true);
    expect(got.some((m) => String(m.type).startsWith("node."))).toBe(false);
    ws.close();
  });

  it("refuses a pairing that isn't asked for properly, and too many at once", async () => {
    const bad = await SELF.fetch("https://atlas.test/nodes/pair/start", {
      method: "POST",
      body: JSON.stringify({ name: "x", kind: "toaster" }),
    });
    expect(bad.status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await SELF.fetch("https://atlas.test/nodes/pair/start", {
        method: "POST",
        body: JSON.stringify({ name: `Mac ${i}`, kind: "desktop" }),
      });
      codes.push(r.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
