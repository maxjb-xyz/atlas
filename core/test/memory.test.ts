import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { undoReceipt } from "../src/agent/undo";
import type { Embedder } from "../src/brains/embed";
import { systemPrompt } from "../src/context";
import { migrate, type Sql } from "../src/store/db";
import { append, type Surface } from "../src/store/log";
import { getMemory, indexNewMessages } from "../src/store/memory";
import { getRecord, recordHistory, standingFacts } from "../src/store/records";
import { readSettings } from "../src/store/settings";
import { startRun } from "../src/store/runs";
import { forget, recall, remember } from "../src/tools/memory";
import { type Tool, type ToolContext, type ToolResult, toSpec } from "../src/tools/types";
import { env, fakeEmbedder } from "./helpers";

const TZ = "America/New_York";
const NOW = new Date("2026-10-21T20:00:00Z"); // Wed 4 PM in New York
const DAY = 86_400_000;

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`m-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

function ctx(sql: Sql, opts: { embed?: Embedder | null; source?: string | null } = {}): ToolContext {
  return {
    sql,
    run_id: startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" }),
    settings: readSettings(sql),
    tz: TZ,
    now: NOW,
    calendar: null,
    clock: { schedule: async () => {}, unschedule: async () => {} },
    embed: opts.embed === undefined ? fakeEmbedder() : opts.embed,
    source_log_id: opts.source ?? null,
    via: "chat",
  };
}

const run = (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => tool.run(tool.input.parse(input) as never, c);

/** One exchange in the log, at a given time: the owner's words and Atlas's reply. */
function exchange(sql: Sql, said: string, reply: string, at: number, surface: Surface = "app"): string {
  const runId = startRun(sql, { actor: "owner", trigger: "message", surface, role: "main" });
  const inRow = append(sql, { actor: "owner", kind: "message.in", run_id: runId, surface, body: { text: said }, at });
  append(sql, { actor: "atlas", kind: "message.out", run_id: runId, surface, body: { text: reply }, at: at + 1000 });
  return inRow.id;
}

type Results = Array<Record<string, unknown>>;
const results = (r: ToolResult) => (r.output as { results: Results }).results;
const notes = (r: ToolResult) => (r.output as { notes?: string[] }).notes ?? [];

describe("remember and forget", () => {
  it("notes a fact with a chip, keeps it in view, and corrects it instead of duplicating", () =>
    withSql(async (sql) => {
      const said = exchange(sql, "I'm vegetarian", "Noted.", NOW.getTime());
      const saved = await run(remember, { type: "preference", name: "Diet", fact: "Max is vegetarian." }, ctx(sql, { source: said }));
      expect(saved.ok).toBe(true);
      expect(saved.receipt).toMatchObject({ text: "Noted · Max is vegetarian.", undo: { kind: "record.forget" } });
      const id = (saved.output as { id: string }).id;
      expect(getRecord(sql, id)!.source).toMatchObject({ via: "chat", log_id: said });

      // In the stable block, with its id, for every run from now on.
      const prompt = systemPrompt({ settings: readSettings(sql), tz: TZ, now: NOW, surface: "app", sql });
      const stable = prompt.split("\n\n---\n\n")[0]!;
      expect(stable).toContain(`- Max is vegetarian. (id ${id})`);

      // Said again with the same name: one record, corrected, old value in history.
      const fixed = await run(remember, { type: "preference", name: "diet", fact: "Max eats fish now." }, ctx(sql));
      expect(fixed.receipt).toMatchObject({ text: "Updated · Max eats fish now.", undo: { kind: "record.revert" } });
      expect(standingFacts(sql).map((r) => r.fields.fact)).toEqual(["Max eats fish now."]);
      expect(recordHistory(sql, id)).toMatchObject([{ name: "Diet", fields: { fact: "Max is vegetarian." } }]);
    }));

  it("forgets a record, and recall stops finding it and the message it came from", () =>
    withSql(async (sql) => {
      const said = exchange(sql, "I'm vegetarian, by the way", "Noted.", NOW.getTime() - DAY);
      const c = ctx(sql, { source: said });
      const id = ((await run(remember, { type: "preference", name: "Vegetarian", fact: "Max is vegetarian." }, c)).output as { id: string })
        .id;
      indexNewMessages(sql);
      expect(results(await run(recall, { query: "vegetarian" }, ctx(sql))).length).toBe(2);

      const gone = await run(forget, { id }, ctx(sql));
      expect(gone.receipt).toMatchObject({ text: "Forgot · Max is vegetarian.", undo: { kind: "record.restore", id } });
      expect(standingFacts(sql)).toEqual([]);
      expect(getMemory(sql, `log:${said}`)).toBeNull();
      expect(results(await run(recall, { query: "vegetarian" }, ctx(sql)))).toEqual([]);
      // The log keeps both: the save and the forget.
      const changes = sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'record.change' ORDER BY seq`)
        .toArray()
        .map((r) => JSON.parse(r.body).change);
      expect(changes).toEqual(["created", "forgotten"]);
    }));

  it("undoes each kind of chip once, and says so in the log", () =>
    withSql(async (sql) => {
      const clock = { schedule: async () => {}, unschedule: async () => {} };
      const chip = (r: ToolResult, runId: string) =>
        append(sql, { actor: "atlas", kind: "tool.result", run_id: runId, body: { ok: r.ok, receipt: r.receipt as never } });

      const c1 = ctx(sql);
      const saved = await run(remember, { type: "note", name: "Gate code", fact: "The gate code is 4417." }, c1);
      const id = (saved.output as { id: string }).id;
      const savedChip = chip(saved, c1.run_id);

      const c2 = ctx(sql);
      const changed = await run(remember, { id, type: "note", name: "Gate code", fact: "The gate code is 9921." }, c2);
      const changedChip = chip(changed, c2.run_id);
      expect(await undoReceipt(sql, changedChip.id, clock)).toMatchObject({ ok: true, row: { body: { undo_of: changedChip.id } } });
      expect(getRecord(sql, id)!.fields.fact).toBe("The gate code is 4417.");
      expect(await undoReceipt(sql, changedChip.id, clock)).toEqual({ ok: false, message: "That's already undone." });

      expect((await undoReceipt(sql, savedChip.id, clock)).ok).toBe(true);
      expect(getRecord(sql, id)!.state).toBe("forgotten");

      const c3 = ctx(sql);
      // Forgetting an already forgotten record is refused in plain words.
      expect((await run(forget, { id }, c3)).output).toEqual({ error: "Gate code is already forgotten." });
    }));

  it("links records, and refuses links to records that don't exist", () =>
    withSql(async (sql) => {
      const jordan = (
        (await run(remember, { type: "person", name: "Jordan Lee", fact: "Jordan is a producer." }, ctx(sql))).output as {
          id: string;
        }
      ).id;
      const shoot = await run(
        remember,
        { type: "goal", name: "Riverside shoot", fact: "A two-day shoot at Riverside Park.", links: [{ to: jordan, kind: "works_with" }] },
        ctx(sql),
      );
      expect(shoot.ok).toBe(true);
      const bad = await run(remember, { type: "note", name: "x", fact: "y", links: [{ to: "rec_nope", kind: "about" }] }, ctx(sql));
      expect(bad.output).toEqual({ error: "There's no record with id rec_nope to link to." });
    }));
});

describe("the tools as brains see them", () => {
  it("leaves fields with defaults optional, and nothing providers refuse", () => {
    const recallSpec = toSpec(recall).parameters as { required: string[] };
    expect(recallSpec.required ?? []).toEqual([]);
    const rememberSpec = JSON.stringify(toSpec(remember).parameters);
    expect(rememberSpec).not.toContain("propertyNames");
    expect((toSpec(remember).parameters as { required: string[] }).required).toEqual(["type", "name", "fact"]);
  });
});

describe("recall", () => {
  it("finds what was said by keyword, with when, how and the reply", () =>
    withSql(async (sql) => {
      exchange(sql, "The Riverside shoot moved to Saturday", "Got it, Saturday.", NOW.getTime() - 3 * DAY, "voice");
      exchange(sql, "What's for lunch?", "Soup.", NOW.getTime() - DAY);
      const r = await run(recall, { query: "Riverside shoot" }, ctx(sql));
      expect(results(r)[0]).toMatchObject({
        kind: "message",
        said_by: "the owner",
        how: "aloud",
        when: "2026-10-18T16:00:00-04:00",
        text: "The Riverside shoot moved to Saturday",
        your_reply: "Got it, Saturday.",
      });
      expect(results(r)[0]!.matched).toContain("keyword");
    }));

  it("finds things by meaning when the words differ", () =>
    withSql(async (sql) => {
      exchange(sql, "Booked the lens hire for Friday", "Nice.", NOW.getTime() - 2 * DAY);
      exchange(sql, "Call the plumber", "Will do.", NOW.getTime() - DAY);
      const r = await run(recall, { query: "camera rental" }, ctx(sql));
      expect(results(r)[0]).toMatchObject({ text: "Booked the lens hire for Friday", matched: ["meaning"] });
    }));

  it("answers by time alone", () =>
    withSql(async (sql) => {
      exchange(sql, "Tuesday thing", "ok", new Date("2026-10-20T15:00:00Z").getTime());
      exchange(sql, "Monday thing", "ok", new Date("2026-10-19T15:00:00Z").getTime());
      const r = await run(recall, { from: "2026-10-20", to: "2026-10-21", only: "messages" }, ctx(sql));
      expect(results(r).map((x) => x.text)).toEqual(["ok", "Tuesday thing"]);
      expect(results(r)[0]!.matched).toEqual(["time"]);
      // Only filler words: still answered by time.
      const asked = await run(recall, { query: "what did we talk about", from: "2026-10-20", to: "2026-10-21" }, ctx(sql));
      expect(results(asked).map((x) => x.text)).toContain("Tuesday thing");
    }));

  it("searches around a person through links and mentions", () =>
    withSql(async (sql) => {
      const jordan = (
        (await run(remember, { type: "person", name: "Jordan", fact: "Jordan produces the shoots." }, ctx(sql))).output as {
          id: string;
        }
      ).id;
      await run(
        remember,
        { type: "goal", name: "Riverside shoot", fact: "Two days at Riverside Park.", links: [{ to: jordan, kind: "works_with" }] },
        ctx(sql),
      );
      await run(remember, { type: "goal", name: "Harbor shoot", fact: "A day at the harbor." }, ctx(sql));
      exchange(sql, "Jordan says Riverside needs permits", "I'll keep that in mind.", NOW.getTime() - DAY);
      exchange(sql, "Riverside weather looks bad", "Noted.", NOW.getTime() - DAY);

      const r = await run(recall, { query: "Riverside", about: "Jordan" }, ctx(sql));
      const found = results(r).map((x) => x.name ?? x.text);
      expect(found).toContain("Riverside shoot");
      expect(found).toContain("Jordan says Riverside needs permits");
      expect(found).not.toContain("Riverside weather looks bad");
      expect(found).not.toContain("Harbor shoot");
      const shoot = results(r).find((x) => x.name === "Riverside shoot")!;
      expect(shoot.linked).toEqual([{ id: jordan, name: "Jordan", kind: "works_with" }]);
      expect(shoot.matched).toContain("link");
    }));

  it("still answers by keyword when meaning search is down, and says why", () =>
    withSql(async (sql) => {
      exchange(sql, "The invoice for Keyframes is due Friday", "Got it.", NOW.getTime() - DAY);
      const r = await run(
        recall,
        { query: "Keyframes invoice" },
        ctx(sql, { embed: fakeEmbedder({ fail: "Workers AI: 429 out of neurons" }) }),
      );
      expect(results(r)[0]).toMatchObject({ text: "The invoice for Keyframes is due Friday", matched: ["keyword"] });
      expect(notes(r)[0]).toContain("Meaning search is down (Workers AI: 429 out of neurons)");
    }));

  it("embeds what's waiting along with the query, in one call", () =>
    withSql(async (sql) => {
      exchange(sql, "one", "two", NOW.getTime() - DAY);
      const e = fakeEmbedder();
      await run(recall, { query: "anything numbered" }, ctx(sql, { embed: e }));
      expect(e.calls).toEqual([["anything numbered", "one", "two"]]);
      await run(recall, { query: "again" }, ctx(sql, { embed: e }));
      expect(e.calls[1]).toEqual(["again"]);
    }));

  it("asks for something to look for", () =>
    withSql(async (sql) => {
      expect((await run(recall, { query: "  " }, ctx(sql))).output).toEqual({
        error: "Say what to look for, give a time range, or name who or what it's about.",
      });
    }));

  it("ranks records recall keeps returning a little higher", () =>
    withSql(async (sql) => {
      await run(remember, { type: "note", name: "Wifi", fact: "The wifi password is on the fridge." }, ctx(sql));
      await run(recall, { query: "wifi" }, ctx(sql));
      const rec = sql.exec<{ recalled: number }>(`SELECT recalled FROM records WHERE name = 'Wifi'`).one();
      expect(rec.recalled).toBe(1);
    }));
});
