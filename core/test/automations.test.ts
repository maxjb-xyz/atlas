import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { type AutomationInput, getAutomation, matchPhrase, nextRun, saveAutomation, setAutomationState } from "../src/automations";
import type { Decider } from "../src/brains/decide";
import type { AutomationView, ServerMessage } from "../src/protocol";
import { migrate, type Sql } from "../src/store/db";
import { append, type LogRow } from "../src/store/log";
import { indexNewMessages } from "../src/store/memory";
import { seedRoutines } from "../src/routines";
import { noticeAsk, openSuggestions, settleSuggestion } from "../src/suggestions";
import { systemPrompt } from "../src/context";
import { install, setExtSecrets } from "../src/extensions";
import { readSettings } from "../src/store/settings";
import { setState } from "../src/store/state";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, SECRET, type Step, offered } from "./helpers";

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

  it("keep their state and test when only the schedule moves, and pause for any other change Atlas makes", () =>
    runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(`a-${crypto.randomUUID()}`)), (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const brief: AutomationInput = {
        name: "Brief",
        about: "",
        when: { kind: "schedule", at: "08:00", days: [] },
        do: [{ kind: "atlas", instructions: "Look at the day." }],
        report: "worth",
      };
      const a = saveAutomation(sql, brief, "owner");
      expect(a.state).toBe("on");
      const moved = saveAutomation(sql, { ...brief, when: { kind: "schedule", at: "07:30", days: [1, 2, 3, 4, 5] } }, "atlas", a.id);
      expect(moved).toMatchObject({ state: "on", report: "worth", when: { at: "07:30" }, changed_by: "owner" });
      const changed = saveAutomation(sql, { ...brief, do: [{ kind: "atlas", instructions: "Look at the week." }] }, "atlas", a.id);
      expect(changed.state).toBe("paused");
    }));

  it("go wherever the owner is unless told one place, keep that place through other edits, and Atlas knows the linked chats", () =>
    runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(`a-${crypto.randomUUID()}`)), (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const brief: AutomationInput = {
        name: "Brief",
        about: "",
        when: { kind: "schedule", at: "08:00", days: [] },
        do: [{ kind: "atlas", instructions: "Look at the day." }],
        report: "thread",
      };
      const a = saveAutomation(sql, brief, "owner");
      expect(a.to).toBe("you");
      const there = saveAutomation(sql, { ...brief, to: "telegram" }, "owner", a.id);
      expect(there.to).toBe("telegram");
      // Moving it to 7:30 without saying where keeps Telegram, and only the place changing doesn't pause it.
      const moved = saveAutomation(sql, { ...brief, when: { kind: "schedule", at: "07:30", days: [] } }, "atlas", a.id);
      expect(moved).toMatchObject({ to: "telegram", state: "on" });

      install(sql, { id: "telegram", source: "bundled" });
      setExtSecrets(sql, "telegram", { bot_token: "123:abc" });
      setState(sql, "channel_links", { telegram: { user: "1", chat: "1", name: "Max", at: Date.now() } });
      const system = systemPrompt({ settings: readSettings(sql), tz: "America/New_York", now: new Date(), surface: "app", sql });
      expect(system).toContain("Telegram (linked to them)");
      expect(system).toContain("Connected services: Telegram: chat with you");
      expect(system).toContain("The owner has no webhooks.");
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
        name: "Weekday brief",
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
      text: "Made automation · Weekday brief · paused until you've seen a test run",
      view: { kind: "automation" },
    });
    expect(offered(b.requests[0]!)).toEqual(expect.arrayContaining(["automation_save", "automation_test", "automation_set"]));
    let v = await view(s, "Weekday brief");
    expect(v).toMatchObject({ state: "paused", made_by: "atlas", can_turn_on: false, next_at: null, when_text: "At 08:00, weekdays" });

    // Not before a test run.
    s.send({ type: "atlas.automation.set", id: v.id, on: true });
    expect((await s.next("atlas.error")).message).toContain("needs a test run first");

    const test = brain([say("Two meetings today, nothing urgent.")]);
    s.send({ type: "atlas.automation.run", id: v.id, test: true });
    v = await view(s, "Weekday brief", (a) => a.tested_at != null);
    expect(v.runs[0]).toMatchObject({ test: true, ok: true, text: "Two meetings today, nothing urgent." });
    expect(v.runs[0]!.results[1]).toMatchObject({ ok: true, text: "Would call Lights off." });
    expect(fetched).toEqual([]); // a test sends nothing
    expect(test.requests[0]!.tools.map((x) => x.name).sort()).toEqual([
      "agenda_list",
      "area_look",
      "calendar_read",
      "file_read",
      "mcp_call",
      "mcp_tools",
      "page_read",
      "place_find",
      "recall",
      "route",
      "skill_read",
      "weather",
      "web_fetch",
      "web_search",
      "webhook_call",
    ]);
    expect(String(test.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!.content)).toContain("This is a test run");

    s.send({ type: "atlas.automation.set", id: v.id, on: true });
    v = await view(s, "Weekday brief", (a) => a.state === "on" && a.next_at != null);
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

    // Moving it from the thread changes only the time: it stays on, with its steps, report and webhook.
    brain([call("automation_save", { id: v.id, when: { kind: "schedule", at: "07:30", days: [1, 2, 3, 4, 5] } }), say("Moved to 7:30.")]);
    const moved = await turn(s, "make the brief 7:30 instead");
    expect(moved.thread.find((r) => r.kind === "tool.result")!.body.receipt).toMatchObject({
      text: "Changed automation · Weekday brief · on",
    });
    v = await view(s, "Weekday brief", (a) => a.when_text === "At 07:30, weekdays");
    expect(v).toMatchObject({ state: "on", report: "thread" });
    expect(v.steps).toHaveLength(2);
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
          when: { kind: "event", on: "automation", after: first.id },
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

  it("include the default routines, made once: the morning brief on and the rest off, each on the clock once on", async () => {
    const s = await connect();
    const brief = await view(s, "Morning brief");
    // The daily looks are the routines (§13.4): the morning brief starts on, and says something only when it's worth saying.
    expect(brief).toMatchObject({ made_by: "default", state: "on", report: "worth", when: { kind: "schedule", at: "08:00" } });
    expect(brief.next_at).not.toBeNull();
    const wrap = await view(s, "Evening wrap-up");
    expect(wrap).toMatchObject({ state: "paused", report: "worth", can_turn_on: true });
    expect(wrap.next_at).toBeNull();
    s.send({ type: "atlas.automation.set", id: wrap.id, on: true });
    expect((await view(s, "Evening wrap-up", (a) => a.state === "on")).next_at).not.toBeNull();
    expect((await view(s, "Weekly review")).when).toMatchObject({ kind: "schedule", days: [0] });
    s.send({ type: "atlas.automation.delete", id: wrap.id });
    await s.next("atlas.automations", (m) => !m.automations.some((a) => a.name === "Evening wrap-up"));
    // Starting again doesn't make a deleted routine again.
    const again = await inOwner((_a, sql) => seedRoutines(sql));
    expect(again).toEqual([]);
    s.close();
  });

  it("the morning brief looks at the day with what came in, stays quiet when there's nothing to say, and speaks as a nudge when there is", async () => {
    const s = await connect();
    const brief = await view(s, "Morning brief");
    const due = () =>
      inOwner(async (agent, sql) => {
        const item = sql
          .exec<{ id: string }>(
            `SELECT id FROM agenda WHERE kind = 'automation' AND state = 'scheduled' AND json_extract(source, '$.detail.automation') = ?`,
            brief.id,
          )
          .one().id;
        sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, item);
        await agent.onAgendaDue({ id: item });
      });
    // Something that could wait came in overnight.
    const waiting = await inOwner(async (_a, sql) => {
      const { take, mark } = await import("../src/intake");
      sql.exec(`UPDATE intake SET seen_at = 1 WHERE seen_at IS NULL`);
      const { fresh } = take(sql, [{ source: "webhook", event: "post", what: "Home server: backup finished", key: `b-${Date.now()}` }]);
      mark(sql, fresh[0]!.id, { state: "weighed", outcome: "later", why: "It can wait." });
      return fresh[0]!.id;
    });
    const quiet = brain([say("A quiet day: nothing worth saying.")]);
    await due();
    const first = (await inOwner((_a, sql) => runs(sql, brief.id))).at(-1)!;
    expect(first).toMatchObject({ ok: true, report: "worth" });
    expect(String(first.text)).toContain("Nothing worth saying");
    const note = String(quiet.requests[0]!.messages.at(-1)!.content);
    expect(note).toContain("What came in since your last look");
    expect(note).toContain("Home server: backup finished");
    expect(quiet.requests[0]!.tools.map((t) => t.name)).toContain("nudge");
    // It looked the pile over, and said nothing in the thread.
    expect(
      await inOwner((_a, sql) => sql.exec<{ seen_at: number | null }>(`SELECT seen_at FROM intake WHERE id = ?`, waiting).one().seen_at),
    ).not.toBeNull();
    const said = () =>
      inOwner((_a, sql) =>
        sql
          .exec<{ body: string }>(
            `SELECT body FROM log WHERE kind = 'message.out' AND json_extract(body, '$.trigger') = ?`,
            `automation:${brief.id}`,
          )
          .toArray()
          .map((r) => JSON.parse(r.body) as Record<string, unknown>),
      );
    expect(await said()).toEqual([]);

    // With something worth saying, it nudges: once, watched for a reaction, and not said again as the run's report.
    brain([call("nudge", { text: "Your 9 o'clock moved to 10.", about: "a moved meeting" }), say("")]);
    await due();
    const out = await said();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "Your 9 o'clock moved to 10.", nudge: { from: "routine", ref: brief.id } });
    const n = await inOwner((_a, sql) =>
      JSON.parse(sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = 'nudges'`).one().value),
    );
    expect(n.at(-1)).toMatchObject({ from: "routine", ref: brief.id, about: "a moved meeting" });
    s.close();
  });

  it("upgrades a deployment from before: the morning brief takes the start-of-day look's time and turns on, and the old looks end", async () => {
    await inOwner(async (_a, sql) => {
      const { ROUTINES } = await import("../src/routines");
      const old = {
        ...ROUTINES[0]!,
        report: "thread" as const,
        do: [{ kind: "atlas" as const, instructions: "Give the owner their morning brief for today." }],
      };
      let id = sql.exec<{ id: string }>(`SELECT id FROM automations WHERE name = 'Morning brief'`).toArray()[0]?.id;
      id = saveAutomation(sql, old, "default", id).id;
      setAutomationState(sql, id, false, "owner");
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('routines', ?, 0)`,
        JSON.stringify({ made_at: 1, ids: [id] }),
      );
      sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('speaking', ?)`,
        JSON.stringify({ noticing: true, leave: true, morning: { on: true, at: "07:30" }, evening: { on: false, at: "20:00" } }),
      );
      const { createItem } = await import("../src/store/agenda");
      const look = createItem(sql, {
        kind: "rhythm",
        title: "Start of day",
        due_at: Date.now() + 3_600_000,
        source: { via: "senses", detail: { moment: "morning" } },
      });
      seedRoutines(sql);
      const a = getAutomation(sql, id)!;
      expect(a).toMatchObject({ report: "worth", state: "on", when: { kind: "schedule", at: "07:30" } });
      expect(sql.exec<{ state: string }>(`SELECT state FROM agenda WHERE id = ?`, look.id).one().state).toBe("cancelled");
      sql.exec(`DELETE FROM settings WHERE key = 'speaking'`);
    });
  });

  it("follow the calendar through the intake: the first look only remembers, a moved event runs once with the change", async () => {
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const events = [
      { id: "e1", calendar: "Work", title: "Riverside walkthrough", start: at(30), end: at(31), all_day: false },
      { id: "e2", calendar: "Home", title: "Dentist", start: at(50), end: at(51), all_day: false },
    ];
    let current = events;
    seams.calendar = {
      async list() {
        return current;
      },
      async check() {
        return { calendars: ["Work"], events_next_30_days: current.length };
      },
    };
    const s = await connect();
    const id = await save(s, {
      name: "Riverside changes",
      about: "",
      when: { kind: "event", on: "calendar", about: "riverside" },
      do: [{ kind: "say", text: "Riverside moved." }],
      report: "thread",
    });
    // A calendar trigger isn't on the clock of its own: the intake's calendar look, on the senses' tick, feeds it.
    const own = await inOwner(
      (_a, sql) =>
        sql
          .exec(
            `SELECT 1 FROM agenda WHERE kind = 'automation' AND state = 'scheduled' AND json_extract(source, '$.detail.automation') = ?`,
            id,
          )
          .toArray().length,
    );
    expect(own).toBe(0);
    const look = () =>
      inOwner(async (agent, sql) => {
        const item = sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'situation' AND state = 'scheduled' LIMIT 1`).one().id;
        sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1000, item);
        await agent.onAgendaDue({ id: item });
      });
    await inOwner((_a, sql) => sql.exec(`DELETE FROM state WHERE key = 'calendar_seen'`));
    await look();
    const moved = { ...events[0]!, start: at(32), end: at(33) };
    current = [moved, { ...events[1]!, start: at(52), end: at(53) }];
    await look();
    const ran = async (n: number) => {
      const end = Date.now() + 5_000;
      while (Date.now() < end) {
        const all = await inOwner((_a, sql) => runs(sql, id));
        if (all.length >= n) return all;
        await new Promise((r) => setTimeout(r, 30));
      }
      return inOwner((_a, sql) => runs(sql, id));
    };
    const all = await ran(1);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ why: "calendar", ok: true, text: "Riverside moved." });
    // Only the Riverside event counts: the dentist moving, then going, isn't about it.
    current = [moved];
    await look();
    await new Promise((r) => setTimeout(r, 300));
    expect(await inOwner((_a, sql) => runs(sql, id))).toHaveLength(1);
    const sensed = await inOwner((_a, sql) =>
      sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'sense' AND json_extract(body, '$.source') = 'calendar' ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(r.body).what as string),
    );
    expect(sensed.slice(-3)).toEqual([
      expect.stringContaining('Moved on the calendar: "Riverside walkthrough"'),
      expect.stringContaining('Moved on the calendar: "Dentist"'),
      expect.stringContaining('Gone from the calendar: "Dentist"'),
    ]);
    s.close();
  });

  it("are suggested after the same ask three times, an hour or more apart, and not again once set aside", () =>
    runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(`s-${crypto.randomUUID()}`)), (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const ask = (text: string, hoursAgo: number) => {
        const row = append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text } });
        sql.exec(`UPDATE log SET at = ? WHERE id = ?`, Date.now() - hoursAgo * 3600_000, row.id);
        return noticeAsk(sql, text);
      };
      expect(ask("Send me the shoot gear checklist", 50)).toBe(false);
      // A retry a few minutes later counts as the same time.
      expect(ask("send me the shoot gear checklist please", 49.9)).toBe(false);
      expect(ask("What's the weather", 30)).toBe(false);
      expect(ask("shoot gear checklist", 26)).toBe(false);
      expect(ask("the shoot gear checklists?", 0)).toBe(true);
      expect(openSuggestions(sql)).toMatchObject([{ said: "the shoot gear checklists?", times: 3 }]);
      // Once more updates the same suggestion.
      expect(ask("shoot gear checklist again", 0)).toBe(true);
      expect(openSuggestions(sql)).toHaveLength(1);
      settleSuggestion(sql, openSuggestions(sql)[0]!.id, "dismissed");
      expect(ask("shoot gear checklist", 0)).toBe(false);
      expect(openSuggestions(sql)).toEqual([]);
      // Something an automation already does isn't suggested.
      saveAutomation(
        sql,
        {
          name: "Weather",
          about: "",
          when: { kind: "request", phrase: "weather forecast" },
          do: [{ kind: "say", text: "x" }],
          report: "thread",
        },
        "owner",
      );
      for (const h of [80, 60, 0]) ask("weather forecast today", h);
      expect(openSuggestions(sql)).toEqual([]);
      // Asking about something gone wrong isn't a routine, however often it's asked.
      for (const h of [90, 70, 0]) expect(ask("Why didn't you tell me about the review request from Doug?", h)).toBe(false);
      expect(openSuggestions(sql)).toEqual([]);
    }));
});
