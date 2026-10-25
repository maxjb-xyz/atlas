// A job's own thread (§21.4): what Atlas said on it, its questions and result, and the owner's words to it,
// oldest first; and its questions and a result with files are in the main thread too.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { folderFor, getOwned, JOB_BUDGET, type Job, saveOwned } from "../src/agent/jobs";
import { createItem } from "../src/store/agenda";
import { append, isThreadRow, thread } from "../src/store/log";
import { fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner } from "./owner";

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.makeBrain = null;
});

describe("a job's thread", () => {
  it("takes the owner's words while a question is open as its answer, so the question shows them", async () => {
    brain([say("Sending both cuts now.")]);
    const { id, log } = await inOwner((_a, sql) => {
      const now = Date.now();
      const item = createItem(sql, {
        kind: "job",
        title: "Launch video",
        due_at: now,
        state: "running",
        source: { via: "chat", detail: { owned: true } },
      });
      const q = append(sql, {
        actor: "atlas",
        kind: "job.question",
        body: { job: item.id, title: "Launch video", text: "Watch the cut and tell me what to change.", options: [] },
      });
      const job: Job = {
        id: item.id,
        title: "Launch video",
        goal: "A 30-second launch video",
        asked_in: null,
        asked_by: null,
        folder: folderFor(item.id),
        brain: "Main",
        phase: "waiting",
        transcript: [],
        notes: "",
        news: [],
        question: { text: "Watch the cut and tell me what to change.", options: [], files: [], log: q.id, at: now },
        site: null,
        work: [],
        until: null,
        now: null,
        latest: null,
        files: [],
        read_web: false,
        deadline: null,
        overdue: false,
        reminded_at: null,
        answered_at: null,
        budget: { ...JOB_BUDGET },
        spent: { turns: 0, tokens: { input: 0, output: 0, cached: 0 }, by: {} },
        went_on_from: [],
        unsure: 0,
        moved_at: now,
        result: null,
        started_at: now,
        progress_at: now,
      };
      saveOwned(sql, job);
      return { id: item.id, log: q.id };
    });
    const s = await connect();
    s.send({ type: "atlas.job.say", id, text: "Send me the video here" });
    const rows = await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "message.in"));
    expect(rows.rows.find((r) => r.kind === "message.in")!.body).toMatchObject({ text: "Send me the video here", job: id, answers: log });
    const job = await inOwner((_a, sql) => getOwned(sql, id)!);
    expect(job.question).toBeNull();
    expect(job.news.at(-1)).toMatchObject({ kind: "answer", text: "Send me the video here" });
  });

  it("answers atlas.job.thread with that job's rows only, oldest first", async () => {
    const job = `job-${crypto.randomUUID()}`;
    const ids = await inOwner((_a, sql) => {
      const asked = append(sql, { actor: "owner", kind: "message.in", body: { text: "Make a launch video" } });
      const update = append(sql, { actor: "atlas", kind: "job.update", body: { job, text: "I found three tracks." } });
      append(sql, { actor: "atlas", kind: "job.update", body: { job: "another-job", text: "Not this one." } });
      const question = append(sql, {
        actor: "atlas",
        kind: "job.question",
        body: { job, title: "Launch video", text: "Which track?", options: ["One", "Two", "Three"] },
      });
      const said = append(sql, { actor: "owner", kind: "settings.change", body: { job, said: "Faster, like the second." } });
      append(sql, { actor: "owner", kind: "settings.change", body: { job, theme: "dark" } });
      const result = append(sql, {
        actor: "atlas",
        kind: "job.result",
        body: { item_id: job, title: "Launch video", state: "done", text: "Here it is.", files: [] },
      });
      return { asked: asked.id, update: update.id, question: question.id, said: said.id, result: result.id };
    });
    const s = await connect();
    s.send({ type: "atlas.job.thread", id: job });
    const reply = await s.next("atlas.job.thread", (m) => m.id === job);
    expect(reply.rows.map((r) => r.id)).toEqual([ids.update, ids.question, ids.said, ids.result]);
  });

  it("keeps what a job did and the owner's words to it out of the main thread, and in the job's", async () => {
    const job = `job-${crypto.randomUUID()}`;
    const ids = await inOwner((_a, sql) => {
      const read = append(sql, {
        actor: "atlas",
        kind: "tool.result",
        body: { name: "browser_open", ok: true, job, receipt: { text: "Read · Pixabay" } },
      });
      const answer = append(sql, { actor: "owner", kind: "message.in", body: { text: "The second one", job, answers: "lg_q" } });
      const words = append(sql, { actor: "owner", kind: "message.in", body: { text: "Faster", job } });
      const mine = append(sql, {
        actor: "atlas",
        kind: "tool.result",
        body: { name: "calendar_read", ok: true, receipt: { text: "Calendar" } },
      });
      expect([read, answer, words, mine].map(isThreadRow)).toEqual([false, false, false, true]);
      return { read: read.id, answer: answer.id, words: words.id };
    });
    const s = await connect();
    s.send({ type: "atlas.job.thread", id: job });
    const reply = await s.next("atlas.job.thread", (m) => m.id === job);
    expect(reply.rows.map((r) => r.id)).toEqual([ids.read, ids.answer, ids.words]);
  });

  it("puts a job's question and a result with files in the main thread, but not a step's result", async () => {
    await inOwner((_a, sql) => {
      const q = append(sql, { actor: "atlas", kind: "job.question", body: { job: "j1", title: "T", text: "Which?", options: ["A"] } });
      const made = append(sql, { actor: "atlas", kind: "job.result", body: { item_id: "j1", state: "done", text: "Done.", files: [] } });
      const step = append(sql, { actor: "atlas", kind: "job.result", body: { item_id: "h1", state: "done", text: "Step.", of: "j1" } });
      const helper = append(sql, { actor: "atlas", kind: "job.result", body: { item_id: "h2", state: "done", text: "Found it." } });
      const update = append(sql, { actor: "atlas", kind: "job.update", body: { job: "j1", text: "Working on it." } });
      expect([q, made, step, helper, update].map(isThreadRow)).toEqual([true, true, false, false, false]);
      const shown = thread(sql, 60).map((r) => r.id);
      expect(shown).toContain(q.id);
      expect(shown).toContain(made.id);
      expect(shown).not.toContain(step.id);
      expect(shown).not.toContain(update.id);
    });
  });
});
