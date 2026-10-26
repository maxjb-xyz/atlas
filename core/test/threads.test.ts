// Threads (VISION §21.1, M7 stage 6e): conversations of their own that run
// side by side, each reading only its own messages, with Today the line to
// Atlas outside any thread.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams, THREAD_HANDS } from "../src/agent";
import type { Brain, BrainEvent, BrainRequest } from "../src/brains/types";
import type { ThreadView } from "../src/protocol";
import { call, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { connect, inOwner, type Socket } from "./owner";

/** What the owner said last in a request, without the turn's note of what's true now. */
const said = (req: BrainRequest) => {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return typeof last?.content === "string" ? last.content.replace(/<now>[\s\S]*?<\/now>/g, "").trim() : "";
};
const naming = (req: BrainRequest) => req.system.startsWith("Below is how one of the owner's conversations");

/** A brain that answers from what was said, so turns running side by side don't race for a script. */
function brain(answer: (req: BrainRequest) => Promise<BrainEvent[]> | BrainEvent[]) {
  const requests: BrainRequest[] = [];
  seams.makeBrain = () =>
    ({
      provider: "chatgpt",
      model: "gpt-5.6-terra",
      async *stream(req: BrainRequest) {
        requests.push(req);
        for (const e of await answer(req)) yield e;
      },
    }) as Brain;
  return requests;
}

/** Starts a thread with its first message and waits for its turn to end. */
async function newThread(s: Socket, text: string, id = text): Promise<string> {
  s.send({ type: "atlas.thread.new", text, client_id: id });
  const made = await s.next("atlas.thread.made", (m) => m.client_id === id);
  const run = await s.next("atlas.run", (m) => m.client_id === id);
  await s.next("atlas.run", (m) => m.run_id === run.run_id && m.state !== "running");
  return made.id;
}

async function say_(s: Socket, text: string, thread?: string): Promise<string> {
  s.send({ type: "atlas.say", text, client_id: text, ...(thread ? { thread } : {}) });
  const run = await s.next("atlas.run", (m) => m.client_id === text);
  await s.next("atlas.run", (m) => m.run_id === run.run_id && m.state !== "running");
  return run.run_id;
}

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("threads", () => {
  it("each read only their own conversation, and Today doesn't read theirs", async () => {
    const requests = brain((req) => (naming(req) ? say("Lisbon trip") : say(`Answered: ${said(req).slice(0, 40)}`)));
    const s = await connect();
    const lisbon = await newThread(s, "plan four days in Lisbon in March");
    await say_(s, "make it five days", lisbon);
    await say_(s, "hey");

    const inThread = requests.find((r) => !naming(r) && said(r).includes("make it five days"))!;
    const words = inThread.messages.map((m) => String(m.content)).join("\n");
    expect(words).toContain("plan four days in Lisbon");
    // Today's turn doesn't carry the thread's conversation, only a line saying it's there.
    const today = requests.find((r) => !naming(r) && said(r) === "hey")!;
    expect(today.messages.map((m) => String(m.content)).join("\n")).not.toContain("plan four days");
    expect(today.messages.map((m) => String(m.content)).join("\n")).toContain(`(thread ${lisbon})`);

    // Atlas named it once it had answered, and the thread's rows say where they are.
    const t = await inOwner((_a, sql) =>
      sql.exec<{ title: string; named: number }>(`SELECT title, named FROM threads WHERE id = ?`, lisbon).one(),
    );
    expect(t).toEqual({ title: "Lisbon trip", named: 1 });
    s.send({ type: "atlas.thread.open", id: lisbon });
    const rows = (await s.next("atlas.thread.rows", (m) => m.id === lisbon)).rows.filter((r) => r.kind.startsWith("message."));
    expect(rows.map((r) => r.body.text)).toEqual([
      "plan four days in Lisbon in March",
      "Answered: plan four days in Lisbon in March",
      "make it five days",
      "Answered: make it five days",
    ]);
    expect(rows.every((r) => r.thread === lisbon)).toBe(true);
  });

  it("run side by side: Today answers while a thread's turn is still working", async () => {
    let finish: () => void = () => {};
    const slow = new Promise<void>((go) => (finish = go));
    brain(async (req) => {
      if (naming(req)) return say("Laptops");
      if (said(req).includes("laptop")) await slow;
      return say("Done.");
    });
    const s = await connect();
    s.send({ type: "atlas.thread.new", text: "compare laptops under $1,500", client_id: "laptops" });
    const research = await s.next("atlas.run", (m) => m.client_id === "laptops");
    const threads = await s.next("atlas.threads", (m) => m.threads.some((t: ThreadView) => t.state === "working"));
    expect(threads.threads[0]!.title).toBe("compare laptops under $1,500");

    // Today's turn ends while the thread's is still going.
    await say_(s, "is it gonna rain?");
    const still = await inOwner(
      (_a, sql) => sql.exec<{ state: string }>(`SELECT state FROM runs WHERE id = ?`, research.run_id).one().state,
    );
    expect(still).toBe("running");
    await inOwner(() => finish());
    await s.next("atlas.run", (m) => m.run_id === research.run_id && m.state !== "running");
  });

  it(`work ${THREAD_HANDS} at a time, and a fifth says it's waiting until a hand is free`, async () => {
    const gates: Array<() => void> = [];
    brain(async (req) => {
      if (naming(req)) return say("A thread");
      if (said(req).startsWith("job")) await new Promise<void>((go) => gates.push(go));
      return say("Done.");
    });
    const s = await connect();
    for (let i = 0; i < THREAD_HANDS + 1; i++) s.send({ type: "atlas.thread.new", text: `job ${i}`, client_id: `job-${i}` });
    const fifth = await s.next("atlas.run", (m) => m.client_id === `job-${THREAD_HANDS}`);
    const wait = await s.next("atlas.status", (m) => m.run_id === fifth.run_id && m.text != null);
    expect(wait.text).toBe(`Waiting for a free hand: ${THREAD_HANDS} threads are working.`);
    // Only four reached the brain; one ending lets the fifth start.
    while (gates.length < THREAD_HANDS) await new Promise((r) => setTimeout(r, 10));
    expect(gates.length).toBe(THREAD_HANDS);
    // Released from inside the agent, so what the turn does next is the agent's own I/O.
    await inOwner(() => gates.shift()!());
    while (gates.length < THREAD_HANDS) await new Promise((r) => setTimeout(r, 10));
    await inOwner(() => {
      for (const go of gates.splice(0)) go();
    });
    await s.next("atlas.run", (m) => m.run_id === fifth.run_id && m.state === "replied");
  }, 20_000);

  it("take a Today message that continues one, with a note and Undo left in Today", async () => {
    let lisbon = "";
    brain((req) => {
      if (naming(req)) return say("Lisbon trip");
      const text = said(req);
      if (text === "hold the 7:40 flight if it's under $600") {
        // The first call moves it; the next answers from what came back.
        const moved = req.messages.some((m) => m.role === "tool");
        return moved ? say("Holding the 7:40 at $548.") : call("thread_continue", { thread: lisbon });
      }
      return say("Sure.");
    });
    const s = await connect();
    lisbon = await newThread(s, "plan the Lisbon trip");
    const run = await say_(s, "hold the 7:40 flight if it's under $600");

    const rows = await inOwner((_a, sql) =>
      sql
        .exec<{ id: string; kind: string; thread: string | null; body: string }>(
          `SELECT id, kind, thread, body FROM log WHERE run_id = ? ORDER BY seq`,
          run,
        )
        .toArray(),
    );
    const note = rows.find((r) => r.kind === "tool.result")!;
    expect(note.thread).toBeNull();
    expect(JSON.parse(note.body).receipt.text).toBe("Went to Lisbon trip");
    expect(rows.filter((r) => r.kind.startsWith("message.")).map((r) => r.thread)).toEqual([lisbon, lisbon]);

    // Undo brings the message and its answer back to Today.
    s.send({ type: "atlas.undo", log_id: note.id });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "thread.change"));
    const back = await inOwner((_a, sql) =>
      sql.exec<{ thread: string | null }>(`SELECT thread FROM log WHERE run_id = ? AND kind LIKE 'message.%'`, run).toArray(),
    );
    expect(back.map((r) => r.thread)).toEqual([null, null]);
  });

  it("start from a message already said: it and its answer move to a thread of their own", async () => {
    brain((req) => (naming(req) ? say("Roof quotes") : say("Three roofers to call.")));
    const s = await connect();
    const run = await say_(s, "find me three roofers for quotes");
    const asked = await inOwner(
      (_a, sql) => sql.exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? AND kind = 'message.in'`, run).one().id,
    );
    s.send({ type: "atlas.thread.split", log_id: asked });
    const made = await s.next("atlas.thread.made", (m) => m.client_id === asked);
    await s.next("atlas.threads", (m) => m.threads.some((t: ThreadView) => t.id === made.id && t.title === "Roof quotes"));
    const moved = await inOwner((_a, sql) =>
      sql.exec<{ thread: string | null }>(`SELECT thread FROM log WHERE run_id = ? AND kind LIKE 'message.%'`, run).toArray(),
    );
    expect(moved.map((r) => r.thread)).toEqual([made.id, made.id]);
  });
});
