import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import type { ServerMessage } from "../src/protocol";
import { getItem } from "../src/store/agenda";
import { migrate, type Sql } from "../src/store/db";
import { type LogRow, thread } from "../src/store/log";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, SECRET, type Step } from "./helpers";

const ORIGIN = "http://atlas.test";

interface Socket {
  send(msg: object): void;
  next<T extends ServerMessage["type"]>(
    type: T,
    where?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  close(): void;
}

async function connect(): Promise<Socket> {
  const res = await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, {
    headers: { Upgrade: "websocket", authorization: `Bearer ${SECRET}` },
  });
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

function brain(steps: Step[]) {
  const b = scripted(steps, "chatgpt", "gpt-5.6-terra");
  seams.makeBrain = () => b.brain;
  return b;
}

/** Says something and waits for the run to end; returns its receipts, from the saved thread. */
async function turn(s: Socket, text: string): Promise<LogRow[]> {
  s.send({ type: "atlas.say", text, client_id: text });
  const started = await s.next("atlas.run", (m) => m.client_id === text);
  await s.next("atlas.run", (m) => m.run_id === started.run_id && m.state !== "running");
  s.send({ type: "atlas.hello" });
  const snap = await s.next("atlas.snapshot");
  return snap.thread.filter((r) => r.run_id === started.run_id && r.kind === "tool.result");
}

const THEN =
  "Recall whether the owner said the landlord replied since Oct 22. If not, remind them to call him. If so, say there's no need.";

/** Makes the landlord promise and returns its id. */
async function promiseLandlord(s: Socket): Promise<string> {
  brain([
    call("promise", { what: "Check whether the landlord replied", then: THEN, at: "2099-01-02T09:00" }),
    say("I'll check Friday morning."),
  ]);
  const [receipt] = await turn(s, "remind me to call the landlord if he hasn't replied by Friday");
  expect(receipt!.body.receipt).toMatchObject({
    text: expect.stringMatching(/^Promised · .* · Check whether the landlord replied$/),
    undo: { kind: "reminder.cancel" },
  });
  return (receipt!.body.receipt as { undo: { id: string } }).undo.id;
}

const due = (id: string) =>
  inOwner(async (agent, sql) => {
    sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, id);
    await agent.onAgendaDue({ id });
  });

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("promises", () => {
  it("are made in the same step, with a receipt, linked to where they were said, and in every run's context", async () => {
    const s = await connect();
    const id = await promiseLandlord(s);
    const item = await inOwner((_a, sql) => getItem(sql, id));
    expect(item).toMatchObject({
      kind: "promise",
      title: "Check whether the landlord replied",
      state: "scheduled",
      source: {
        log_id: expect.stringMatching(/^lg_/),
        detail: { said: "remind me to call the landlord if he hasn't replied by Friday", then: THEN },
      },
    });
    const b = brain([say("Sure.")]);
    await turn(s, "what's on?");
    expect(b.requests[0]!.system).toContain(`your promise: Check whether the landlord replied (id ${id})`);
    s.close();
  });

  it("are kept when due: Atlas works from its own note with its tools, then tells the owner", async () => {
    const s = await connect();
    const id = await promiseLandlord(s);
    const b = brain([call("recall", { query: "landlord replied" }), say("He hasn't replied. Time to call the landlord.")]);
    await due(id);
    const kept = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && r.body.trigger === `agenda:${id}`));
    expect(kept.rows.find((r) => r.kind === "message.out")!.body.text).toBe("He hasn't replied. Time to call the landlord.");
    // The loop keeps adding to the same message list, so the note is the last of the user's side.
    const note = String(b.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!.content);
    expect(note).toContain(`It's time to keep a promise you made`);
    expect(note).toContain(`The owner had said: "remind me to call the landlord if he hasn't replied by Friday"`);
    expect(note).toContain(`Your note to yourself: ${THEN}`);
    // It can look, and promise again; it can't save facts about the owner (§5.4).
    const tools = b.requests[0]!.tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["recall", "promise", "agenda_cancel", "calendar_read"]));
    expect(tools).not.toContain("remember");
    expect((await inOwner((_a, sql) => getItem(sql, id)))!.state).toBe("done");
    s.close();
  });

  it("still reach the owner when no brain answers", async () => {
    const s = await connect();
    const id = await promiseLandlord(s);
    brain([new Error("down"), new Error("down")]);
    await due(id);
    const kept = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && r.body.trigger === `agenda:${id}`));
    expect(kept.rows.find((r) => r.kind === "message.out")!.body.text).toBe(
      "It's time for what I promised: Check whether the landlord replied. I couldn't look into it just now, because no brain answered.",
    );
    s.close();
  });

  it("are cancelled by saying never mind, from Agenda, or with Undo, and History keeps both", async () => {
    const s = await connect();
    const a = await promiseLandlord(s);
    brain([call("agenda_cancel", { id: a }), say("Dropped it.")]);
    const [cancelled] = await turn(s, "never mind the landlord thing");
    expect(cancelled!.body.receipt).toEqual({ text: "Cancelled promise · Check whether the landlord replied" });
    expect((await inOwner((_a, sql) => getItem(sql, a)))!.state).toBe("cancelled");

    const b = await promiseLandlord(s);
    s.send({ type: "atlas.agenda.cancel", id: b });
    // Messages are handled in order: once Inbox answers, the cancel has landed.
    s.send({ type: "atlas.inbox" });
    await s.next("atlas.inbox.items");
    const changes = await inOwner((_a, sql) =>
      sql
        .exec<{ actor: string; change: string }>(
          `SELECT actor, json_extract(body, '$.change') AS change FROM log WHERE kind = 'agenda.change' AND json_extract(body, '$.item_id') = ? ORDER BY seq`,
          b,
        )
        .toArray(),
    );
    expect(changes).toEqual([
      { actor: "atlas", change: "created" },
      { actor: "owner", change: "cancelled" },
    ]);
    // The thread shows the cancel too, so the promise's receipt there stops offering an Undo.
    const shown = await inOwner((_a, sql) => thread(sql, 60));
    expect(shown.some((r) => r.kind === "agenda.change" && r.body.item_id === b && r.body.change === "cancelled")).toBe(true);

    brain([call("promise", { what: "Look at flights again", then: "Check fares to Denver.", at: "2099-01-03T09:00" }), say("Will do.")]);
    const [made] = await turn(s, "check flights again later");
    s.send({ type: "atlas.undo", log_id: made!.id });
    const undone = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.undo_of === made!.id));
    expect(undone.rows.find((r) => r.kind === "agenda.change")!.body).toMatchObject({ kind: "promise", change: "cancelled", by: "owner" });
    s.close();
  });

  it("fire once after a restart cut the run that was keeping them", async () => {
    const s = await connect();
    const id = await promiseLandlord(s);
    // As if a restart had cut off a run holding the lease, which has since run out.
    await inOwner((_a, sql) =>
      sql.exec(`UPDATE agenda SET state = 'running', lease_until = ?, due_at = ? WHERE id = ?`, Date.now() - 1, Date.now() - 60_000, id),
    );
    brain([say("He hasn't replied: time to call the landlord.")]);
    await inOwner((agent) => agent.onAgendaDue({ id }));
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && r.body.trigger === `agenda:${id}`));
    // The wake set for the lease finds it kept, and does nothing.
    await inOwner((agent) => agent.onAgendaDue({ id }));
    const said = await inOwner((_a, sql) =>
      sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM log WHERE kind = 'message.out' AND json_extract(body, '$.trigger') = ?`,
          `agenda:${id}`,
        )
        .one(),
    );
    expect(said.n).toBe(1);
    s.close();
  });
});
