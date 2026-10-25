import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BrainRouter } from "../src/brains/router";
import { BrainError } from "../src/brains/types";
import { type LoopEvent, runLoop, type RunSpec } from "../src/loop";
import { upcoming } from "../src/store/agenda";
import { migrate, type Sql } from "../src/store/db";
import { forRun, logTo, thread } from "../src/store/log";
import { correctRecord, createRecord, recordHistory } from "../src/store/records";
import { ClientMessage } from "../src/protocol";
import { readSettings, secretValues, setSecret, writeSettings } from "../src/store/settings";
import { endRun, getRun, startRun, sweepStaleRuns } from "../src/store/runs";
import { getState } from "../src/store/state";
import { calendarRead } from "../src/tools/calendar";
import { agendaTools } from "../src/tools/agenda";
import type { ToolContext } from "../src/tools/types";
import { call, env, fakeCalendar, say, scripted, type Step } from "./helpers";

/** Runs `fn` against a fresh agent's own SQLite. */
async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`t-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

const TZ = "America/New_York";
const NOW = new Date("2026-10-21T20:00:00Z"); // 4 PM in New York

function setup(sql: Sql, steps: Step[], opts: Partial<RunSpec> = {}, extraBrains: Step[][] = []) {
  const main = scripted(steps, "chatgpt", "main");
  const others = extraBrains.map((s, i) => scripted(s, "workers-ai", `backup${i}`));
  const brains = [main, ...others];
  const router = new BrainRouter((c) => brains.find((b) => b.brain.model === c.model)?.brain ?? null);
  const scheduled: string[] = [];
  const toolContext: Omit<ToolContext, "run_id"> = {
    sql,
    settings: readSettings(sql),
    tz: TZ,
    now: NOW,
    calendar: fakeCalendar([
      {
        id: "e1",
        calendar: "Work",
        title: "Design review",
        start: "2026-10-22T14:00:00.000Z",
        end: "2026-10-22T15:00:00.000Z",
        all_day: false,
      },
    ]),
    clock: {
      schedule: async (item) => void scheduled.push(item.id),
      unschedule: async () => {},
    },
    embed: null,
    source_log_id: null,
    via: "chat",
    helpers: null,
    exit: null,
    automations: null,
    web: null,
    browser: null,
    files: null,
    workspace: null,
  };
  const runId = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
  const events: LoopEvent[] = [];
  const spec: RunSpec = {
    runId,
    role: "main",
    surface: "app",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [calendarRead, ...agendaTools],
    budget: { steps: 10, ms: 60_000 },
    joiner: "\n\n",
    firstEventMs: 2_000,
    ...opts,
  };
  const deps = { log: logTo(sql), router, chain: brains.map((b) => ({ provider: b.brain.provider, model: b.brain.model })), toolContext };
  return { main, others, router, scheduled, runId, events, run: () => runLoop(deps, spec, (e) => events.push(e)) };
}

describe("the loop", () => {
  it("answers in one step when no tool is needed", () =>
    withSql(async (sql) => {
      const t = setup(sql, [say("Hey. What's up?")]);
      const res = await t.run();
      expect(res).toMatchObject({
        state: "replied",
        text: "Hey. What's up?",
        steps: 1,
        brain: { provider: "chatgpt", model: "main" },
        fallback: false,
      });
      expect(t.main.requests[0]!.tools.map((x) => x.name)).toEqual([
        "calendar_read",
        "reminder_create",
        "promise",
        "agenda_list",
        "agenda_cancel",
      ]);
    }));

  it("calls a tool, gives the model its result, and answers", () =>
    withSql(async (sql) => {
      const t = setup(sql, [call("calendar_read", { start: "2026-10-22" }), say("Design review at 10 tomorrow.")]);
      const res = await t.run();
      expect(res.state).toBe("replied");
      expect(res.steps).toBe(2);
      const second = t.main.requests[1]!;
      const toolMsg = second.messages.find((m) => m.role === "tool")!;
      const output = JSON.parse((toolMsg as { content: string }).content);
      expect(output.events[0]).toMatchObject({ title: "Design review", start: "2026-10-22T10:00:00-04:00" });
      const kinds = forRun(sql, t.runId).map((r) => r.kind);
      expect(kinds).toEqual(["tool.call", "tool.result"]);
    }));

  it("sets a reminder with a receipt and undo, and schedules it", () =>
    withSql(async (sql) => {
      const t = setup(sql, [call("reminder_create", { text: "Call mom", at: "2026-10-21T18:30" }), say("I'll remind you at 6:30.")]);
      await t.run();
      const [item] = upcoming(sql);
      expect(item).toMatchObject({ title: "Call mom", due_at: Date.parse("2026-10-21T22:30:00Z"), state: "scheduled" });
      expect(t.scheduled).toEqual([item!.id]);
      const receipt = t.events.find((e) => e.type === "row")!;
      expect(receipt.type === "row" && receipt.row.body.receipt).toMatchObject({ undo: { kind: "reminder.cancel", id: item!.id } });
      expect(thread(sql, 10).some((r) => r.kind === "tool.result")).toBe(true);
    }));

  it("starts with the common tools and loads a group by name, or by calling one of its tools (§4.1)", () =>
    withSql(async (sql) => {
      const agenda = { name: "agenda", about: "reminders and promises", tools: agendaTools };
      const t = setup(sql, [call("tools_load", { groups: ["agenda"] }, "c1"), call("agenda_list", {}, "c2"), say("Nothing coming up.")], {
        tools: [calendarRead],
        groups: [agenda],
      });
      await t.run();
      const names = (i: number) => t.main.requests[i]!.tools.map((x) => x.name);
      // First only what it starts with, and the index, which lists each group's tools.
      expect(names(0)).toEqual(["calendar_read", "tools_load"]);
      expect(t.main.requests[0]!.tools.find((x) => x.name === "tools_load")!.description).toContain(
        "agenda: reminders and promises (reminder_create, promise, agenda_list, agenda_cancel)",
      );
      // Then the group, for the rest of the turn.
      expect(names(1)).toEqual(expect.arrayContaining(["calendar_read", "tools_load", "reminder_create", "agenda_list"]));
      expect(t.main.requests[1]!.messages.find((m) => m.role === "tool" && m.name === "tools_load")!.content).toContain("reminder_create");

      // Calling a group's tool by name loads it and runs it, with its status line.
      const u = setup(sql, [call("reminder_create", { text: "Stretch", at: "2026-10-21T18:30" }), say("Set.")], {
        tools: [calendarRead],
        groups: [agenda],
      });
      await u.run();
      expect(upcoming(sql).some((i) => i.title === "Stretch")).toBe(true);
      expect(u.main.requests[1]!.tools.map((x) => x.name)).toContain("promise");
      // An unknown group says what there is.
      const v = setup(sql, [call("tools_load", { groups: ["nope"] }), say("Hm.")], { tools: [], groups: [agenda] });
      await v.run();
      expect(v.main.requests[1]!.messages.find((m) => m.role === "tool")!.content).toContain(
        "There's no group called nope. The groups are: agenda.",
      );
    }));

  it("tells the model when its arguments don't fit or the time is past", () =>
    withSql(async (sql) => {
      const t = setup(sql, [
        call("reminder_create", { text: "x" }, "c1"),
        call("reminder_create", { text: "x", at: "2026-10-20T09:00" }, "c2"),
        say("Done."),
      ]);
      await t.run();
      const outputs = t.main.requests[2]!.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
      expect(outputs[0]).toContain("at:");
      expect(outputs[1]).toContain("in the past");
      expect(upcoming(sql)).toEqual([]);
    }));

  it("falls back to the next brain when one fails before answering, and logs why", () =>
    withSql(async (sql) => {
      const t = setup(sql, [new BrainError("ChatGPT: HTTP 503")], {}, [[say("Answer from the backup.")]]);
      const res = await t.run();
      expect(res).toMatchObject({ state: "replied", text: "Answer from the backup.", fallback: true, brain: { model: "backup0" } });
      const row = t.events.find((e) => e.type === "row");
      expect(row?.type === "row" && row.row.body).toMatchObject({
        from: "chatgpt:main",
        to: "workers-ai:backup0",
        reason: "ChatGPT: HTTP 503",
      });
      expect(t.router.snapshot()["chatgpt:main"]!.ok).toBe(false);
    }));

  it("moves on when a brain is silent too long", () =>
    withSql(async (sql) => {
      const t = setup(sql, [], { firstEventMs: 50 }, [[say("I'm here.")]]);
      t.main.brain.stream = async function* () {
        await new Promise((r) => setTimeout(r, 500));
        yield { type: "text", text: "late" };
      };
      const res = await t.run();
      expect(res.text).toBe("I'm here.");
    }));

  it("in voice, starts the next brain when the first is slow, uses whichever speaks first, and cools the slow one", () =>
    withSql(async (sql) => {
      const t = setup(sql, [], { hedgeMs: 30, firstEventMs: 2_000 }, [[say("Quick answer.")]]);
      let stopped = false;
      t.main.brain.stream = async function* (req) {
        await new Promise((r) => setTimeout(r, 400));
        stopped = req.signal?.aborted ?? false;
        yield { type: "text", text: "Slow answer." };
      };
      const started = Date.now();
      const res = await t.run();
      expect(res).toMatchObject({ state: "replied", text: "Quick answer.", fallback: true, brain: { model: "backup0" } });
      expect(Date.now() - started).toBeLessThan(400);
      const row = t.events.find((e) => e.type === "row");
      expect(row?.type === "row" && row.row.body).toMatchObject({ from: "chatgpt:main", to: "workers-ai:backup0" });
      expect(String(row?.type === "row" && row.row.body.reason)).toMatch(/slower to start/);
      // The slow one waits at the back of the chain for the next turn.
      expect(
        t.router
          .chain([
            { provider: "chatgpt", model: "main" },
            { provider: "workers-ai", model: "backup0" },
          ])
          .map((b) => b.model),
      ).toEqual(["backup0", "main"]);
      await new Promise((r) => setTimeout(r, 450));
      expect(stopped).toBe(true);
    }));

  it("in voice, keeps the first brain when it starts before the next one does", () =>
    withSql(async (sql) => {
      const t = setup(sql, [], { hedgeMs: 20 }, [[]]);
      t.main.brain.stream = async function* () {
        await new Promise((r) => setTimeout(r, 40));
        yield { type: "text", text: "First, a little late." };
      };
      t.others[0]!.brain.stream = async function* () {
        await new Promise((r) => setTimeout(r, 300));
        yield { type: "text", text: "Second." };
      };
      const res = await t.run();
      expect(res).toMatchObject({ text: "First, a little late.", fallback: false, brain: { model: "main" } });
      expect(t.events.some((e) => e.type === "row")).toBe(false);
      // The one started second only lost the race: it isn't held against it.
      expect(t.router.snapshot()["workers-ai:backup0"]).toBeUndefined();
    }));

  it("fails with every reason when no brain can answer", () =>
    withSql(async (sql) => {
      const t = setup(sql, [new BrainError("down")], {}, [[new BrainError("also down")]]);
      const res = await t.run();
      expect(res.state).toBe("failed");
      expect(res.error).toContain("chatgpt:main: down");
      expect(res.error).toContain("workers-ai:backup0: also down");
    }));

  it("ends with one tool-free answer when the step budget runs out", () =>
    withSql(async (sql) => {
      const t = setup(sql, [call("agenda_list", {}), call("agenda_list", {}), say("Here's what I found. Want me to keep going?")], {
        budget: { steps: 2, ms: 60_000 },
      });
      const res = await t.run();
      expect(res).toMatchObject({ state: "replied", steps: 3 });
      expect(t.main.requests[2]!.tools).toEqual([]);
      expect(t.main.requests[2]!.system).toContain("step budget");
    }));

  it("gives voice a status line when a tool starts before any words", () =>
    withSql(async (sql) => {
      const t = setup(sql, [call("calendar_read", {}), say("You're free.")], { surface: "voice", joiner: " " });
      const res = await t.run();
      expect(t.events.find((e) => e.type === "status" && e.text)).toEqual({
        type: "status",
        text: "Checking your calendar.",
        speakable: true,
      });
      expect(res.text).toBe("You're free.");
    }));

  it("still gives the status line when the brain only sends the whole tool call", () =>
    withSql(async (sql) => {
      const whole = [
        { type: "tool_call" as const, call: { id: "c1", name: "calendar_read", input: {} } },
        { type: "done" as const, finish: "tool_calls" as const },
      ];
      const t = setup(sql, [whole, say("You're free.")], { surface: "voice", joiner: " " });
      await t.run();
      expect(t.events.find((e) => e.type === "status" && e.text)).toEqual({
        type: "status",
        text: "Checking your calendar.",
        speakable: true,
      });
    }));

  it("closes what Atlas said before a lookup, so voice can speak it while the tool runs", () =>
    withSql(async (sql) => {
      const t = setup(sql, [[{ type: "text", text: "Let me look." }, ...call("calendar_read", {})], say("You're free.")], {
        surface: "voice",
        joiner: " ",
      });
      const res = await t.run();
      const order = t.events.filter((e) => e.type === "text" || e.type === "tools").map((e) => (e.type === "text" ? e.text : "[tools]"));
      expect(order).toEqual(["Let me look.", " ", "[tools]", "You're free."]);
      expect(res.text).toBe("Let me look. You're free.");
    }));

  it("doesn't speak a status line once Atlas has said something", () =>
    withSql(async (sql) => {
      const t = setup(sql, [[{ type: "text", text: "Let me look." }, ...call("calendar_read", {})], say("You're free.")], {
        surface: "voice",
        joiner: " ",
      });
      const res = await t.run();
      expect(t.events.find((e) => e.type === "status" && e.text)).toMatchObject({ speakable: false });
      expect(res.text).toBe("Let me look. You're free.");
    }));

  it("stops when interrupted and keeps what was said", () =>
    withSql(async (sql) => {
      const ctrl = new AbortController();
      const t = setup(sql, [], { signal: ctrl.signal });
      t.main.brain.stream = async function* (req) {
        yield { type: "text", text: "Sure" };
        ctrl.abort();
        if (!req.signal?.aborted) yield { type: "text", text: ", and another thing" };
      };
      const res = await t.run();
      expect(res).toMatchObject({ state: "replied", interrupted: true, text: "Sure" });
    }));

  it("fails a run interrupted before any words", () =>
    withSql(async (sql) => {
      const ctrl = new AbortController();
      ctrl.abort();
      const t = setup(sql, [say("too late")], { signal: ctrl.signal });
      const res = await t.run();
      expect(res).toMatchObject({ state: "failed", interrupted: true });
    }));
});

describe("the store", () => {
  it("saves exactly one final state per run, and sweeps lost runs", () =>
    withSql((sql) => {
      const a = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
      endRun(sql, a, "replied", 2);
      endRun(sql, a, "failed", 3);
      expect(getRun(sql, a)).toMatchObject({ state: "replied", steps: 2 });
      const b = startRun(sql, { actor: "owner", trigger: "voice", surface: "voice", role: "voice" });
      expect(sweepStaleRuns(sql, 0)).toBe(1);
      expect(getRun(sql, b)!.state).toBe("failed");
      expect(thread(sql, 10).map((r) => r.body.error)).toContain("Atlas restarted before this finished.");
    }));

  it("keeps the old value when a record is corrected", () =>
    withSql((sql) => {
      const r = createRecord(sql, { type: "person", name: "Jordan Lee", fields: { phone: "555-0100" }, source: { via: "chat" } });
      const fixed = correctRecord(sql, r.id, { fields: { phone: "555-0199", nickname: null } }, "owner corrected it", { via: "owner" });
      expect(fixed.fields).toEqual({ phone: "555-0199" });
      expect(recordHistory(sql, r.id)).toMatchObject([{ name: "Jordan Lee", fields: { phone: "555-0100" }, reason: "owner corrected it" }]);
    }));

  it("fills in default settings and validates patches", () =>
    withSql((sql) => {
      const s = readSettings(sql);
      expect(s.assistant_name).toBe("Atlas");
      expect(s.brains.main[0]).toEqual({ provider: "chatgpt", model: "gpt-5.6-terra" });
      expect(s.voice.elevenlabs_model).toBe("eleven_v4_turbo");
      writeSettings(sql, { owner_name: "Max" });
      expect(readSettings(sql).owner_name).toBe("Max");
      expect(() => writeSettings(sql, { brains: { main: [], voice: [] } } as never)).toThrow();
      // Changing one setting leaves the others as they were, not back at their defaults.
      writeSettings(sql, { assistant_name: "Jarvis" });
      expect(writeSettings(sql, { timezone: "Europe/London" })).toEqual(["timezone"]);
      expect(readSettings(sql)).toMatchObject({ assistant_name: "Jarvis", owner_name: "Max", timezone: "Europe/London" });
      expect(ClientMessage.parse({ type: "atlas.settings.update", patch: { pins: [] } })).toEqual({
        type: "atlas.settings.update",
        patch: { pins: [] },
      });
    }));

  it("moves what isn't a secret out of the secrets table", async () => {
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`t-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, 1);
      const put = (name: string, value: unknown) =>
        sql.exec(`INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, 1)`, name, JSON.stringify(value));
      put("icloud_refused", { at: 5, message: "401" });
      put("chatgpt_client", { host_id: "urn:uuid:x", id_token: "eyJ-hint-token", models: ["gpt-6.1-sol"] });
      put("elevenlabs_api_key", "sk_eleven_1234567890");
      migrate(sql);
      expect(getState(sql, "icloud_refused")).toEqual({ at: 5, message: "401" });
      expect(getState<{ models: string[] }>(sql, "chatgpt_client")!.models).toEqual(["gpt-6.1-sol"]);
      const left = sql
        .exec<{ name: string }>(`SELECT name FROM secrets`)
        .toArray()
        .map((r) => r.name);
      expect(left).toEqual(["elevenlabs_api_key"]);
      // The sign-in hint is still kept from leaving.
      expect(secretValues(sql).sort()).toEqual(["eyJ-hint-token", "sk_eleven_1234567890"]);
    });
  });

  it("lists only real secret values for the scrubber", () =>
    withSql((sql) => {
      setSecret(sql, "elevenlabs_api_key", "sk_eleven_1234567890");
      setSecret(sql, "icloud", { username: "max@icloud.com", app_password: "abcd-efgh-ijkl-mnop" });
      expect(secretValues(sql).sort()).toEqual(["abcd-efgh-ijkl-mnop", "sk_eleven_1234567890"]);
    }));
});
