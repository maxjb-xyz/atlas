import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { type Action, countApproval, earnsTrust, permits, setTrust, TRUST_AFTER } from "../src/approvals";
import { allowed } from "../src/workspace";
import { Settings } from "../src/store/settings";
import type { ServerMessage } from "../src/protocol";
import { migrate, type Sql } from "../src/store/db";
import type { LogRow } from "../src/store/log";
import { createRecord, getRecord } from "../src/store/records";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, SECRET, type Step } from "./helpers";

const ORIGIN = "http://atlas.test";
const auth = { authorization: `Bearer ${SECRET}` };
const HOOK = "https://hooks.example.com/api/webhook/lights-off-8f3a";

interface Socket {
  send(msg: object): void;
  next<T extends ServerMessage["type"]>(
    type: T,
    where?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  close(): void;
}

async function connect(): Promise<Socket> {
  const res = await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, { headers: { Upgrade: "websocket", ...auth } });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as { type?: string };
    if (m.type?.startsWith("atlas.")) inbox.push(m as ServerMessage);
  });
  const s: Socket = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    async next(type, where = () => true) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const i = inbox.findIndex((m) => m.type === type && where(m as never));
        if (i >= 0) return inbox.splice(i, 1)[0] as never;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${type} within 5 s; got ${inbox.map((m) => m.type).join(", ")}`);
    },
    close: () => ws.close(),
  };
  s.send({ type: "atlas.hello", tz: "America/New_York" });
  await s.next("atlas.snapshot");
  return s;
}

const owner = () => env.PersonAgent.get(env.PersonAgent.idFromName("owner"));
const inOwner = <T>(fn: (agent: PersonAgent, sql: Sql) => Promise<T> | T) =>
  runInDurableObject(owner(), async (agent: PersonAgent, state) => {
    migrate(state.storage.sql);
    return fn(agent, state.storage.sql);
  });
const rowsOf = (m: Extract<ServerMessage, { type: "atlas.rows" }>, kind: string): LogRow[] => m.rows.filter((r) => r.kind === kind);

let calls: Array<{ url: string; body: string }> = [];

function brain(steps: Step[]) {
  const b = scripted(steps, "chatgpt", "gpt-5.6-terra");
  seams.makeBrain = () => b.brain;
  return b;
}

/** Says something and waits for the run to end; returns the receipts it made, from the saved thread. */
async function turn(s: Socket, text: string): Promise<LogRow[]> {
  s.send({ type: "atlas.say", text, client_id: text });
  const started = await s.next("atlas.run", (m) => m.client_id === text);
  await s.next("atlas.run", (m) => m.run_id === started.run_id && m.state !== "running");
  s.send({ type: "atlas.hello" });
  const snap = await s.next("atlas.snapshot");
  return snap.thread.filter((r) => r.run_id === started.run_id && r.kind === "tool.result");
}

async function addHook(s: Socket, name = "Lights off") {
  // The owner's agent keeps its storage across these tests: reuse a webhook made earlier.
  s.send({ type: "atlas.hello" });
  const had = (await s.next("atlas.snapshot")).view.webhooks.find((w) => w.name === name);
  if (had) return had;
  s.send({ type: "atlas.webhook.save", name, url: HOOK, method: "POST", about: "Turns off the living room lights" });
  const v = await s.next("atlas.view", (m) => m.view.webhooks.some((w) => w.name === name));
  return v.view.webhooks.find((w) => w.name === name)!;
}

beforeEach(() => {
  calls = [];
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  seams.fetch = null;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("approvals", () => {
  it("hold a webhook call for the owner's OK, then call it once approved, with receipts and a line in the thread", async () => {
    const s = await connect();
    const hook = await addHook(s);
    expect(hook).toMatchObject({ host: "hooks.example.com", method: "POST" });
    expect(JSON.stringify(hook)).not.toContain("lights-off-8f3a"); // the address never reaches the app

    const b = brain([call("webhook_call", { webhook: "lights off" }), say("Waiting for your OK to turn them off.")]);
    const [receipt] = await turn(s, "turn off the lights");
    // The model was told about the webhook, and that it waits.
    expect(b.requests[0]!.system).toContain("- Lights off: Turns off the living room lights");
    expect(receipt!.body.receipt).toMatchObject({ text: "Waiting for your OK · Lights off", approval: expect.stringMatching(/^ag_/) });
    expect(String(receipt!.body.output)).toContain("waiting_for_ok");
    expect(calls).toEqual([]);

    const id = (receipt!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const items = await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.kind === "approval"));
    expect(items.items[0]).toMatchObject({
      kind: "approval",
      title: "Lights off",
      approval: {
        hold: false,
        asked: "turn off the lights",
        steps: [{ kind: "webhook", title: "Call Lights off", where: "POST to hooks.example.com", message: "" }],
        checks: [
          { name: "Secrets", ok: true },
          { name: "Your OK", ok: false },
        ],
      },
    });

    s.send({ type: "atlas.approval.decide", id, yes: true, edits: [{ index: 0, message: "Night mode" }] });
    const settled = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));
    const line = settled.rows.find((r) => r.kind === "agenda.change")!;
    expect(line.body).toMatchObject({ kind: "approval", by: "owner", via: "app", edited: true, ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ text: "Night mode", from: "Atlas" });

    // Answered once is answered.
    s.send({ type: "atlas.approval.decide", id, yes: true });
    expect((await s.next("atlas.error")).message).toBe("That one was already approved.");
    s.close();
  });

  it("make one card for a plan of several steps, and take only a hold for what can't be undone", async () => {
    const s = await connect();
    await addHook(s);
    const id = await inOwner(
      (_a, sql) =>
        createRecord(sql, { type: "note", name: "Old Riverside note", fields: { fact: "The old shoot plan." }, source: { via: "chat" } })
          .id,
    );
    brain([
      call("webhook_call", { webhook: "Lights off" }, "c1"),
      call("delete_for_good", { id }, "c2"),
      say("Both are waiting in Inbox."),
    ]);
    const receipts = await turn(s, "turn off the lights and delete the old Riverside note for good");
    const approvals = new Set(receipts.map((r) => (r.body.receipt as { approval: string }).approval));
    expect(approvals.size).toBe(1);
    const [approval] = [...approvals];

    s.send({ type: "atlas.inbox" });
    const items = await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.id === approval && i.approval!.steps.length === 2));
    expect(items.items.find((i) => i.id === approval)!.approval).toMatchObject({
      title: "Lights off, then Delete Old Riverside note",
      hold: true,
      steps: [{ kind: "webhook" }, { kind: "delete", detail: "The old shoot plan." }],
    });

    // A tap isn't enough for something that can't be undone.
    s.send({ type: "atlas.approval.decide", id: approval, yes: true });
    expect((await s.next("atlas.error")).message).toContain("needs a hold to confirm");
    expect(calls).toEqual([]);

    s.send({ type: "atlas.approval.decide", id: approval, yes: true, hold: true });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));
    expect(calls).toHaveLength(1);
    await inOwner((_a, sql) => {
      expect(getRecord(sql, id)).toBeNull();
      // Its values are gone from the log; that it was deleted stays.
      const bodies = sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind IN ('record.change', 'tool.call', 'tool.result')`)
        .toArray();
      expect(bodies.some((b) => b.body.includes("The old shoot plan"))).toBe(false);
      expect(bodies.some((b) => b.body.includes('"change":"deleted"'))).toBe(true);
    });
    s.close();
  });

  it("take a spoken or typed yes through the approve tool, but never for what needs a hold", async () => {
    const s = await connect();
    await addHook(s);
    brain([call("webhook_call", { webhook: "Lights off" }), say("Waiting for your OK.")]);
    const [receipt] = await turn(s, "lights off please");
    const id = (receipt!.body.receipt as { approval: string }).approval;

    const b = brain([call("approve", { id, yes: true }), say("Done, they're off.")]);
    await turn(s, "yes, do it");
    expect(b.requests[0]!.system).toContain(`- Lights off (id ${id}`);
    expect(calls).toHaveLength(1);
    expect(String(b.requests[1]!.messages.at(-1)!.content)).toContain("Called Lights off: hooks.example.com answered 200");

    const rec = await inOwner((_a, sql) => createRecord(sql, { type: "note", name: "Scratch", source: { via: "chat" } }).id);
    brain([call("delete_for_good", { id: rec }), say("It's waiting in Inbox.")]);
    const [del] = await turn(s, "erase the scratch note for good");
    const delId = (del!.body.receipt as { approval: string }).approval;
    const v = brain([call("approve", { id: delId, yes: true }), say("That one needs you to hold to confirm in the app.")]);
    await turn(s, "yes");
    expect(String(v.requests[1]!.messages.at(-1)!.content)).toContain("needs a hold to confirm");
    await inOwner((_a, sql) => expect(getRecord(sql, rec)).not.toBeNull());
    s.close();
  });

  it("run out on time and say what didn't happen", async () => {
    const s = await connect();
    await addHook(s);
    brain([call("webhook_call", { webhook: "Lights off" }), say("Waiting.")]);
    const [receipt] = await turn(s, "lights off");
    const id = (receipt!.body.receipt as { approval: string }).approval;
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, id);
      await agent.onAgendaDue({ id });
    });
    const expired = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "failed"));
    expect(expired.rows.find((r) => r.kind === "agenda.change")!.body).toMatchObject({
      kind: "approval",
      expired: true,
      title: "Lights off",
    });
    expect(calls).toEqual([]);
    s.send({ type: "atlas.approval.decide", id, yes: true });
    expect((await s.next("atlas.error")).message).toBe("That one was already closed: it ran out.");
    s.close();
  });

  it("offer to stop asking after five approvals as-is, and stop when the owner says yes", async () => {
    const s = await connect();
    const hook = await addHook(s, "Coffee");
    const key = `webhook:${hook.id}`;
    const action = { kind: "webhook" as const, webhook: hook.id, name: "Coffee" };
    await inOwner((_a, sql) => {
      for (let i = 1; i < TRUST_AFTER; i++) expect(countApproval(sql, [action], true)).toEqual([]);
      // An edit starts the count again.
      expect(countApproval(sql, [action], false)).toEqual([]);
      for (let i = 1; i < TRUST_AFTER; i++) countApproval(sql, [action], true);
      expect(countApproval(sql, [action], true)).toEqual([key]);
    });
    s.send({ type: "atlas.inbox" });
    const items = await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.kind === "question"));
    expect(items.items.find((i) => i.kind === "question")).toMatchObject({ id: key, title: "Call Coffee without asking?" });

    s.send({ type: "atlas.trust.set", key, trusted: true });
    const view = await s.next("atlas.view", (m) => m.view.permissions.trusted.length > 0);
    expect(view.view.permissions.trusted).toEqual([{ key, name: "Coffee", since: expect.any(Number) }]);

    brain([call("webhook_call", { webhook: "Coffee" }), say("Coffee's on.")]);
    const [receipt] = await turn(s, "start the coffee");
    expect(receipt!.body.receipt).toEqual({ text: "Done · Coffee" });
    expect(calls).toHaveLength(1);
    s.close();
  });

  it("can be approved from a push notification's button, over HTTP", async () => {
    const s = await connect();
    await addHook(s, "Porch light");
    brain([call("webhook_call", { webhook: "Porch light" }), say("Waiting.")]);
    const [receipt] = await turn(s, "porch light on");
    const id = (receipt!.body.receipt as { approval: string }).approval;
    const res = await SELF.fetch(`${ORIGIN}/api/approve`, { method: "POST", headers: auth, body: JSON.stringify({ id }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, text: expect.stringContaining("Called Porch light") });
    expect((await SELF.fetch(`${ORIGIN}/api/approve`, { method: "POST", body: JSON.stringify({ id }) })).status).toBe(401);
    s.close();
  });

  it("won't let a secret out in a webhook's message", async () => {
    const s = await connect();
    await addHook(s, "Announce");
    s.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value: "sk_eleven_secret_value" } });
    await s.next("atlas.view", (m) => m.view.secrets.elevenlabs_api_key);
    brain([call("webhook_call", { webhook: "Announce", message: "the key is sk_eleven_secret_value" }), say("Waiting.")]);
    const [receipt] = await turn(s, "announce the key");
    const id = (receipt!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const items = await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.id === id));
    expect(items.items.find((i) => i.id === id)!.approval!.checks[0]).toEqual({ name: "Secrets", ok: false });
    s.send({ type: "atlas.approval.decide", id, yes: true });
    const done = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "delivery"));
    expect(done.rows.find((r) => r.kind === "delivery")!.body).toMatchObject({ ok: false, checks: { secrets: "failed" } });
    expect(calls).toEqual([]);
    s.close();
  });
});

describe("your own rules (§12.3)", () => {
  const rules = (p: Partial<Settings["permissions"]> = {}) => Settings.parse({ permissions: p }).permissions;
  const hook: Action = { kind: "webhook", webhook: "wh_rules", name: "Porch light" };
  const mail = (as: "owner" | "atlas"): Action => ({
    kind: "email",
    name: "Mail Doug",
    as,
    via: "gmail",
    from: "me@example.com",
    to: ["doug@acme.com"],
    subject: "Thursday",
    text: "See you then.",
  });
  const form: Action = { kind: "browser", ref: "12", name: "Send the form", url: "https://forms.example.com/rsvp", what: "RSVP yes" };
  const site: Action = { kind: "site", host: "api.example.com", name: "Reach api.example.com", why: "the docs" };
  const reply: Action = {
    kind: "face_reply",
    name: "Front desk's answer as you",
    face: "f1",
    conv: "c1",
    where: {},
    text: "Hi",
    person: "rec_doug",
  };
  const del: Action = { kind: "delete", record: "rec_1", name: "the note", fact: "x" };
  const mcpTool = (tool: string): Action => ({
    kind: "mcp",
    server: "mcp_linear",
    name: `${tool} on Linear`,
    tool,
    arguments: {},
    destructive: false,
    what: "",
    where: "Linear",
  });
  const base = { read_web: false, sites: ["example.com"] };

  it("start as Atlas behaved before: outside actions ask until trusted, sites and forms ask, the web makes everything ask", () =>
    inOwner((_a, sql) => {
      const p = rules();
      for (const a of [hook, mail("owner"), form, site, reply]) expect(permits(sql, a, { ...base, permissions: p })).toBe(false);
      expect(earnsTrust(mail("owner"), p)).toBe(true);
    }));

  it("let the owner loosen what they choose, and never what can't be undone, a new service or a vault login", () =>
    inOwner((_a, sql) => {
      const loose = rules({ outside: "never", sites: "any", forms: "allowed_sites", faces_known: "send" });
      const go = (a: Action, o: Partial<typeof base> = {}) => permits(sql, a, { ...base, ...o, permissions: loose });
      expect(go(hook)).toBe(true);
      expect(go(site)).toBe(true);
      // Forms go on sites the owner picked themselves: not under "any site", where sites join without asking,
      // and not in a run that has read the web elsewhere.
      expect(go(form)).toBe(false);
      // The gate: a site the owner allowed and what's under it, or any host under "any site".
      expect([allowed("cdn.pixabay.com", ["pixabay.com"]), allowed("evil.test", ["pixabay.com"]), allowed("evil.test", ["*"])]).toEqual([
        true,
        false,
        true,
      ]);
      // Under "any site" a site isn't asked about even once a run has read the web: the workspace reaches them all.
      expect(permits(sql, site, { ...base, read_web: true, permissions: loose })).toBe(true);
      expect(permits(sql, site, { ...base, read_web: true, permissions: rules({}) })).toBe(false);
      const forms = rules({ forms: "allowed_sites" });
      expect(permits(sql, form, { ...base, permissions: forms })).toBe(true);
      expect(permits(sql, form, { ...base, read_web: true, permissions: forms })).toBe(false);
      expect(permits(sql, { ...form, url: "https://elsewhere.test/submit" } as Action, { ...base, permissions: forms })).toBe(false);
      expect(go(reply)).toBe(true);
      // A face reply to someone Atlas doesn't know still asks under its own rule.
      const { person: _, ...stranger } = reply as Extract<Action, { kind: "face_reply" }>;
      expect(permits(sql, stranger, { ...base, permissions: rules({ faces_known: "send" }) })).toBe(false);
      // Floors.
      expect(go(del)).toBe(false);
      expect(go({ kind: "mcp_add", name: "Linear", url: "https://mcp.linear.app", why: "issues" })).toBe(false);
      expect(
        go({
          kind: "vault",
          entry: "v1",
          name: "Bank",
          host: "bank.example.com",
          url: "https://bank.example.com",
          card: false,
          fields: {},
        }),
      ).toBe(false);
      // After reading the web, everything leaving asks, unless the owner said trusted things can go.
      expect(go(hook, { read_web: true })).toBe(false);
      // "Not for what you trust" means only that: what isn't trusted still asks, whatever else is loosened.
      const trustedAfter = rules({ outside: "never", sites: "any", after_web: "trusted" });
      expect(permits(sql, hook, { ...base, read_web: true, permissions: trustedAfter })).toBe(false);
      // A site under "any site" is the exception: the workspace already reaches every site, so there's nothing to ask.
      expect(permits(sql, site, { ...base, read_web: true, permissions: trustedAfter })).toBe(true);
      for (let i = 0; i < TRUST_AFTER; i++) countApproval(sql, [hook], true);
      setTrust(sql, "webhook:wh_rules", true);
      expect(permits(sql, hook, { ...base, read_web: true, permissions: trustedAfter })).toBe(true);
      setTrust(sql, "webhook:wh_rules", false);
      // Nothing to earn when nothing asks.
      expect(earnsTrust(hook, loose)).toBe(false);
    }));

  it("let the owner tighten mail in their name and tools on their devices, and stop offering trust for them", () =>
    inOwner((_a, sql) => {
      const tight = rules({ email_as_you: "always", device_tools: "always" });
      expect(earnsTrust(mail("owner"), tight)).toBe(false);
      expect(earnsTrust(mail("atlas"), tight)).toBe(true);
      const node: Action = { kind: "node", node: "n1", device: "Mac", name: "Run ls", tool: "shell", input: { cmd: "ls" }, what: "ls" };
      expect(earnsTrust(node, tight)).toBe(false);
      // Already trusted, mail as the owner still asks.
      const key = "email:owner:doug@acme.com";
      for (let i = 0; i < TRUST_AFTER; i++) countApproval(sql, [mail("owner")], true);
      setTrust(sql, key, true);
      expect(permits(sql, mail("owner"), { ...base, permissions: rules() })).toBe(true);
      expect(permits(sql, mail("owner"), { ...base, permissions: tight })).toBe(false);
      setTrust(sql, key, false);
    }));

  it("trust a whole MCP service once one of its tools is trusted, when the owner says so", () =>
    inOwner((_a, sql) => {
      for (let i = 0; i < TRUST_AFTER; i++) countApproval(sql, [mcpTool("create_issue")], true);
      setTrust(sql, "mcp:mcp_linear:create_issue", true);
      expect(permits(sql, mcpTool("create_issue"), { ...base, permissions: rules() })).toBe(true);
      expect(permits(sql, mcpTool("update_issue"), { ...base, permissions: rules() })).toBe(false);
      expect(permits(sql, mcpTool("update_issue"), { ...base, permissions: rules({ mcp: "per_service" }) })).toBe(true);
      setTrust(sql, "mcp:mcp_linear:create_issue", false);
    }));

  it("do an outside action without a card once the owner says Atlas doesn't need to ask", async () => {
    const s = await connect();
    await addHook(s, "Porch light");
    s.send({ type: "atlas.settings.update", patch: { permissions: { ...rules(), outside: "never" } } });
    await s.next("atlas.view", (m) => m.view.settings.permissions.outside === "never");
    brain([call("webhook_call", { webhook: "Porch light" }), say("The porch light's on.")]);
    const [receipt] = await turn(s, "porch light on");
    expect(receipt!.body.receipt).toEqual({ text: "Done · Porch light" });
    expect(calls).toHaveLength(1);
    s.send({ type: "atlas.settings.update", patch: { permissions: rules() } });
    await s.next("atlas.view", (m) => m.view.settings.permissions.outside === "until_trusted");
    s.close();
  });
});
