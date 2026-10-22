import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { history, historyStats, inbox, inboxDone, listRecords, recordView } from "../src/agent/views";
import { migrate, type Sql } from "../src/store/db";
import { append } from "../src/store/log";
import { correctRecord, createRecord, forgetRecord } from "../src/store/records";
import { endRun, startRun } from "../src/store/runs";
import { env } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`v-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

describe("Library", () => {
  it("lists records with their source, counts by type, and shows a correction's old value", () =>
    withSql((sql) => {
      const run = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
      const said = append(sql, {
        actor: "owner",
        kind: "message.in",
        run_id: run,
        surface: "voice",
        body: { text: "Mom's number ends in 2290" },
      });
      const mom = createRecord(sql, {
        type: "person",
        name: "Mom",
        fields: { fact: "Mom's number ends in 2290." },
        source: { via: "chat", log_id: said.id },
      });
      createRecord(sql, { type: "place", name: "Lake Eola", source: { via: "chat" } });
      const gone = createRecord(sql, { type: "note", name: "Old", source: { via: "chat" } });
      forgetRecord(sql, gone.id, { via: "owner" });
      correctRecord(sql, mom.id, { fields: { fact: "Mom's number ends in 0417." } }, "corrected in Library", { via: "owner" });

      const all = listRecords(sql, {});
      expect(all.records.map((r) => r.name)).toEqual(["Mom", "Lake Eola"]);
      expect(all.counts).toMatchObject({ all: 2, person: 1, place: 1, note: 0 });
      expect(all.records[0]).toMatchObject({
        fact: "Mom's number ends in 0417.",
        source: { via: "chat", text: "Mom's number ends in 2290", surface: "voice" },
        corrections: 1,
        was: { name: "Mom", fact: "Mom's number ends in 2290." },
      });
      expect(listRecords(sql, { type: "place" }).records.map((r) => r.name)).toEqual(["Lake Eola"]);
      expect(listRecords(sql, { text: "0417" }).records.map((r) => r.name)).toEqual(["Mom"]);
      expect(recordView(sql, mom).id).toBe(mom.id);
    }));
});

describe("History", () => {
  it("shows what happened, filtered, with today's totals", () =>
    withSql((sql) => {
      const run = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
      append(sql, { actor: "owner", kind: "message.in", run_id: run, body: { text: "remind me" } });
      append(sql, { actor: "atlas", kind: "tool.call", run_id: run, body: { name: "reminder_create" } });
      append(sql, { actor: "atlas", kind: "tool.result", run_id: run, body: { ok: true, receipt: { text: "Reminder · Thu 9:40" } } });
      append(sql, { actor: "atlas", kind: "tool.result", run_id: run, body: { ok: true } });
      append(sql, { actor: "atlas", kind: "message.out", run_id: run, body: { text: "Set.", usage: { input: 100, output: 20 } } });
      endRun(sql, run, "replied", 2);

      const everything = history(sql, { filter: "everything" });
      expect(everything.rows.map((r) => r.kind)).toEqual(["tool.result", "message.in"]);
      expect(history(sql, { filter: "conversations" }).rows.map((r) => r.kind)).toEqual(["message.out", "message.in"]);
      expect(history(sql, { filter: "actions" }).rows.length).toBe(1);
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const stats = historyStats(sql, day.getTime());
      expect(stats).toMatchObject({ actions: 1, conversations: 1, jobs: 0, tokens: 120 });
      expect(stats.per_hour.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }));
});

describe("Inbox", () => {
  it("holds finished background work and failures until the owner marks them done", () =>
    withSql((sql) => {
      const job = append(sql, {
        actor: "atlas",
        kind: "job.result",
        body: { item_id: "ag_1", title: "Clashes", state: "done", text: "None." },
      });
      const run = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
      endRun(sql, run, "failed", 0, { error: "No brain could answer." });
      const quiet = startRun(sql, { actor: "atlas", trigger: "compaction", surface: "none", role: "main" });
      endRun(sql, quiet, "failed", 0, { error: "429" });
      expect(inbox(sql).map((i) => [i.kind, i.title])).toEqual([
        ["failed", "A reply didn't finish"],
        ["review", "Clashes"],
      ]);
      inboxDone(sql, job.id);
      expect(inbox(sql).map((i) => i.title)).toEqual(["A reply didn't finish"]);
    }));
});
