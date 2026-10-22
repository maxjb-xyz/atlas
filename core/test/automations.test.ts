import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { type AutomationInput, getAutomation, matchPhrase, nextRun, saveAutomation, setAutomationState } from "../src/automations";
import type { Decider } from "../src/brains/decide";
import type { AutomationView, ServerMessage } from "../src/protocol";
import { migrate, type Sql } from "../src/store/db";
import { append, type LogRow } from "../src/store/log";
import { indexNewMessages } from "../src/store/memory";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, SECRET, type Step } from "./helpers";

const ORIGIN = "http://atlas.test";
const HOOK = "https://hooks.example.com/api/webhook/lights-1f2e";

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

let fetched: Array<{ url: string; body: string }> = [];
let page = "";
const pageNow = (html: string) => (page = html);

function brain(steps: Step[]) {
  const b = scripted(steps, "chatgpt", "gpt-5.6-terra");
  seams.makeBrain = () => b.brain;
  return b;
}
/** Saves an automation the way the form does (it's armed on the clock), and returns its id. */
async function save(s: Socket, automation: AutomationInput): Promise<string> {
  s.send({ type: "atlas.automation.save", automation });
  return (await view(s, automation.name)).id;
}

/** A brain that must not be asked: a phrase with fixed steps runs with no model call. */
function noBrain() {
  seams.makeBrain = () => {
    throw new Error("no model should be called");
  };
}

async function turn(s: Socket, text: string): Promise<{ run_id: string; state: string; thread: LogRow[] }> {
  s.send({ type: "atlas.say", text, client_id: text });
  const started = await s.next("atlas.run", (m) => m.client_id === text);
  const ended = await s.next("atlas.run", (m) => m.run_id === started.run_id && m.state !== "running");
  s.send({ type: "atlas.hello" });
  const snap = await s.next("atlas.snapshot");
  return { run_id: started.run_id, state: ended.state, thread: snap.thread.filter((r) => r.run_id === started.run_id) };
}

async function view(s: Socket, name: string, where: (a: AutomationView) => boolean = () => true): Promise<AutomationView> {
  s.send({ type: "atlas.automations" });
  const m = await s.next("atlas.automations", (x) => x.automations.some((a) => a.name === name && where(a)));
  return m.automations.find((a) => a.name === name)!;
}

const runs = (sql: Sql, id: string) =>
  sql
    .exec<{ body: string }>(
      `SELECT body FROM log WHERE kind = 'automation.run' AND json_extract(body, '$.automation_id') = ? ORDER BY seq`,
      id,
    )
    .toArray()
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);

async function hook(s: Socket) {
  s.send({ type: "atlas.hello" });
  if ((await s.next("atlas.snapshot")).view.webhooks.some((w) => w.name === "Lights off")) return;
  s.send({ type: "atlas.webhook.save", name: "Lights off", url: HOOK, method: "POST", about: "Turns off the lights" });
  await s.next("atlas.view", (m) => m.view.webhooks.some((w) => w.name === "Lights off"));
}

beforeEach(() => {
  fetched = [];
  page = "";
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.fetch = (async (url: string, init: RequestInit = {}) => {
    fetched.push({ url: String(url), body: String(init.body ?? "") });
    return new Response(String(url).startsWith("https://shop.example.com") ? page : "ok", { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  seams.fetch = null;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.decide = undefined;
});

describe("when automations run", () => {
  const TZ = "America/New_York";
  it("find the next time on the days asked, in the owner's time zone", () => {
    const friEvening = new Date("2026-10-23T22:00:00-04:00");
    expect(nextRun({ kind: "schedule", at: "08:00", days: [1, 2, 3, 4, 5] }, friEvening, TZ)?.toISOString()).toBe(
      "2026-10-26T12:00:00.000Z",
    );
    expect(nextRun({ kind: "schedule", at: "23:30", days: [] }, friEvening, TZ)?.toISOString()).toBe("2026-10-24T03:30:00.000Z");
    expect(nextRun({ kind: "absence", nothing_about: "workout", for_days: 3, at: "20:00" }, friEvening, TZ)?.toISOString()).toBe(
      "2026-10-25T00:00:00.000Z",
    );
    expect(
      nextRun({ kind: "watch", url: "https://shop.example.com/x", every_hours: 6, matters: "a sale" }, friEvening, TZ)!.getTime(),
    ).toBe(friEvening.getTime() + 6 * 3600_000);
    expect(nextRun({ kind: "request" }, friEvening, TZ)).toBeNull();
  });

  it("answer only to their exact phrase, with its inputs, and only when on", () =>
    runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(`a-${crypto.randomUUID()}`)), (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const focus = saveAutomation(
        sql,
        {
          name: "Focus",
          about: "",
          when: { kind: "request", phrase: "focus for $duration" },
          do: [{ kind: "say", text: "Focusing for $duration." }],
          report: "thread",
        },
        "owner",
      );
      saveAutomation(
        sql,
        {
          name: "Night",
          about: "",
          when: { kind: "request", phrase: "goodnight" },
          do: [{ kind: "say", text: "Night." }],
          report: "thread",
        },
        "owner",
      );
      expect(matchPhrase(sql, "Goodnight!")?.automation.name).toBe("Night");
      expect(matchPhrase(sql, "goodnight everyone")).toBeNull();
      expect(matchPhrase(sql, "Focus for 45 minutes")).toMatchObject({ automation: { name: "Focus" }, inputs: { duration: "45 minutes" } });
      setAutomationState(sql, focus.id, false, "owner");
      expect(matchPhrase(sql, "focus for an hour")).toBeNull();
      expect(() =>
        saveAutomation(
          sql,
          {
            name: "Night 2",
            about: "",
            when: { kind: "request", phrase: "Goodnight." },
            do: [{ kind: "say", text: "x" }],
            report: "thread",
          },
          "owner",
        ),
      ).toThrow('"Goodnight." already runs Night.');
    }));
});

describe("automations", () => {
  it("run a phrase's fixed steps fast, with no model call, and History shows no brain", async () => {
    const s = await connect();
    await hook(s);
    const input: AutomationInput = {
      name: "Goodnight",
      about: "Lights off and a goodnight",
      when: { kind: "request", phrase: "goodnight" },
      do: [
        { kind: "webhook", webhook: "Lights off" },
        { kind: "say", text: "Lights are off. Sleep well." },
      ],
      report: "thread",
    };
    s.send({ type: "atlas.automation.save", automation: input });
    const v = await view(s, "Goodnight");
    expect(v).toMatchObject({ state: "on", made_by: "owner", can_turn_on: true, when_text: 'When you say "goodnight", or press Run' });

    noBrain();
    const t = await turn(s, "Goodnight");
    expect(t.state).toBe("replied");
    expect(t.thread.find((r) => r.kind === "message.out")!.body.text).toBe("Lights are off. Sleep well.");
    expect(fetched.map((f) => f.url)).toEqual([HOOK]);
    const done = await inOwner((_a, sql) => runs(sql, v.id));
    expect(done.at(-1)).toMatchObject({
      why: "request",
      ok: true,
      brain: null,
      results: [{ ok: true }, { ok: true, text: "Lights are off. Sleep well." }],
    });
    s.close();
  });

  it("made by Atlas start paused, need a test run that sends nothing, then run on their schedule", async () => {
    const s = await connect();
    await hook(s);
    const b = brain([
      call("automation_save", {
        name: "Morning brief",
        when: { kind: "schedule", at: "08:00", days: [1, 2, 3, 4, 5] },
        do: [
          { kind: "atlas", instructions: "Look at today's calendar and reminders and give a three-line brief." },
          { kind: "webhook", webhook: "Lights off" },
        ],
      }),
      say("Made it; it's paused until you've seen a test run."),
    ]);
    const made = await turn(s, "every weekday at 8, give me a short brief");
    expect(made.thread.find((r) => r.kind === "tool.result")!.body.receipt).toMatchObject({
      text: "Made automation · Morning brief · paused until you've seen a test run",
      view: { kind: "automation" },
    });
    expect(b.requests[0]!.tools.map((x) => x.name)).toEqual(
      expect.arrayContaining(["automation_save", "automation_test", "automation_set"]),
    );
    let v = await view(s, "Morning brief");
    expect(v).toMatchObject({ state: "paused", made_by: "atlas", can_turn_on: false, next_at: null, when_text: "At 08:00, weekdays" });

    // Not before a test run.
    s.send({ type: "atlas.automation.set", id: v.id, on: true });
    expect((await s.next("atlas.error")).message).toContain("needs a test run first");

    const test = brain([say("Two meetings today, nothing urgent.")]);
    s.send({ type: "atlas.automation.run", id: v.id, test: true });
    v = await view(s, "Morning brief", (a) => a.tested_at != null);
    expect(v.runs[0]).toMatchObject({ test: true, ok: true, text: "Two meetings today, nothing urgent." });
    expect(v.runs[0]!.results[1]).toMatchObject({ ok: true, text: "Would call Lights off." });
    expect(fetched).toEqual([]); // a test sends nothing
    expect(test.requests[0]!.tools.map((x) => x.name).sort()).toEqual(["agenda_list", "calendar_read", "recall", "webhook_call"]);
    expect(String(test.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!.content)).toContain("This is a test run");

    s.send({ type: "atlas.automation.set", id: v.id, on: true });
    v = await view(s, "Morning brief", (a) => a.state === "on" && a.next_at != null);
    expect(new Date(v.next_at!).getUTCMinutes()).toBe(0);

    // The clock wakes it: it runs, reports in the thread, calls the webhook it was allowed, and is set for next time.
    brain([say("Quiet day: one call at 2.")]);
    const item = await inOwner(
      (_a, sql) =>
        sql
          .exec<{ id: string }>(
            `SELECT id FROM agenda WHERE kind = 'automation' AND state = 'scheduled' AND json_extract(source, '$.detail.automation') = ?`,
            v.id,
          )
          .one().id,
    );
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, item);
      await agent.onAgendaDue({ id: item });
    });
    const sent = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && r.body.trigger === `automation:${v.id}`));
    expect(sent.rows.find((r) => r.kind === "message.out")!.body.text).toBe("Quiet day: one call at 2.");
    expect(fetched.map((f) => f.url)).toEqual([HOOK]);
    const again = await inOwner((_a, sql) =>
      sql.exec<{ state: string; due_at: number }>(`SELECT state, due_at FROM agenda WHERE id = ?`, item).one(),
    );
    expect(again.state).toBe("scheduled");
    expect(again.due_at).toBeGreaterThan(Date.now());
    s.close();
  });

  it("tell the owner after two failures in a row, and pause themselves after five", async () => {
    const s = await connect();
    const id = await inOwner(
      (_a, sql) =>
        saveAutomation(
          sql,
          { name: "Flaky", about: "", when: { kind: "request" }, do: [{ kind: "atlas", instructions: "Say hi." }], report: "thread" },
          "owner",
        ).id,
    );
    brain(Array.from({ length: 20 }, () => new Error("down")));
    const press = async () => {
      s.send({ type: "atlas.automation.run", id });
      await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "automation.run" && r.body.automation_id === id));
    };
    await press();
    await press();
    const told = await s.next("atlas.rows", (m) =>
      m.rows.some((r) => r.kind === "message.out" && String(r.body.text).startsWith("Flaky failed twice")),
    );
    expect(told).toBeTruthy();
    for (let i = 0; i < 3; i++) await press();
    const v = await view(s, "Flaky", (a) => a.state === "paused");
    expect(v.paused_why).toContain("It failed 5 times in a row");
    expect(v.runs[0]).toMatchObject({ ok: false, error: expect.stringContaining("No brain could answer") });
    s.close();
  });

  it("watch a page, stay quiet until a change matters, and say so in History", async () => {
    const decider: Decider & { asked: string[] } = {
      model: "fake",
      asked: [],
      async yesNo(state) {
        this.asked.push(state);
        return { matters: /\$249/.test(state) ? 0.9 : 0.1 };
      },
    };
    seams.decide = decider;
    const s = await connect();
    const id = await save(s, {
      name: "Lens price",
      about: "",
      when: { kind: "watch", url: "https://shop.example.com/lens", every_hours: 6, matters: "the price drops below $300" },
      do: [{ kind: "atlas", instructions: "Tell the owner the new price." }],
      report: "thread",
    });
    const wake = () =>
      inOwner(async (agent, sql) => {
        const item = sql
          .exec<{ id: string }>(
            `SELECT id FROM agenda WHERE kind = 'automation' AND state = 'scheduled' AND json_extract(source, '$.detail.automation') = ?`,
            id,
          )
          .one().id;
        sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, item);
        await agent.onAgendaDue({ id: item });
      });
    pageNow("<html><h1>35mm lens</h1><p>$329</p><script>x()</script></html>");
    await wake(); // first look
    await wake(); // no change
    pageNow("<html><h1>35mm lens</h1><p>$319</p><p>Free shipping</p></html>");
    await wake(); // changed, doesn't matter
    brain([say("The lens dropped to $249.")]);
    pageNow("<html><h1>35mm lens</h1><p>$249</p></html>");
    await wake(); // matters
    const all = await inOwner((_a, sql) => runs(sql, id));
    expect(all.map((r) => (r.quiet ? `quiet: ${String(r.text).split(":")[0]}` : `ran: ${r.text}`))).toEqual([
      "quiet: First look",
      "quiet: No change.",
      "quiet: It changed, but not in a way that matters (10% that it does).",
      "ran: The lens dropped to $249.",
    ]);
    expect(decider.asked.at(-1)).toContain("+ $249");
    s.close();
  });

  it("notice when something didn't happen, once per stretch, and stay quiet when it did", async () => {
    const s = await connect();
    const id = await save(s, {
      name: "Workout nudge",
      about: "",
      when: { kind: "absence", nothing_about: "workout", for_days: 3, at: "20:00" },
      do: [{ kind: "say", text: "No workout logged in 3 days." }],
      report: "thread",
    });
    const wake = () =>
      inOwner(async (agent, sql) => {
        const item = sql
          .exec<{ id: string }>(
            `SELECT id FROM agenda WHERE kind = 'automation' AND state = 'scheduled' AND json_extract(source, '$.detail.automation') = ?`,
            id,
          )
          .one().id;
        sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, item);
        await agent.onAgendaDue({ id: item });
      });
    await wake();
    await wake();
    await inOwner((_a, sql) => {
      append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text: "Logged a workout: 5k run" } });
      indexNewMessages(sql);
      sql.exec(`UPDATE automations SET memo = '{}' WHERE id = ?`, id);
    });
    await wake();
    const all = await inOwner((_a, sql) => runs(sql, id));
    expect(all.map((r) => (r.quiet ? "quiet" : "ran"))).toEqual(["ran", "quiet", "quiet"]);
    expect(String(all[1]!.text)).toContain("already told");
    expect(String(all[2]!.text)).toContain('Found something about "workout"');
    s.close();
  });

  it("run after another one finishes, with what it said", async () => {
    const s = await connect();
    const ids = await inOwner((_a, sql) => {
      const first = saveAutomation(
        sql,
        { name: "Pack up", about: "", when: { kind: "request" }, do: [{ kind: "say", text: "Studio closed." }], report: "silent" },
        "owner",
      );
      const then = saveAutomation(
        sql,
        {
          name: "After pack up",
          about: "",
          when: { kind: "event", after: first.id },
          do: [{ kind: "atlas", instructions: "Say what the first one said." }],
          report: "thread",
        },
        "owner",
      );
      return { first: first.id, then: then.id };
    });
    const b = brain([say("It said the studio's closed.")]);
    s.send({ type: "atlas.automation.run", id: ids.first });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.out" && r.body.trigger === `automation:${ids.then}`));
    expect(String(b.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!.content)).toContain(
      '"Pack up" just finished. What it said: Studio closed.',
    );
    expect(await inOwner((_a, sql) => getAutomation(sql, ids.then)!.fails)).toBe(0);
    s.close();
  });
});
