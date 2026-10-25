// A job's own thread (§21.4): what Atlas said on it, its questions and result, and the owner's words to it,
// oldest first; and its questions and a result with files are in the main thread too.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { append, isThreadRow, thread } from "../src/store/log";
import { fakeCalendar, fakeEmbedder } from "./helpers";
import { connect, inOwner } from "./owner";

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("a job's thread", () => {
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
