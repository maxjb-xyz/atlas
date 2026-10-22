import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { correctAreas, DISCOVER_AFTER, readyToDiscover, startDiscovered, tagPending, triedDiscovery, unfiled } from "../src/agent/areas";
import { hat, systemPrompt } from "../src/context";
import { areaByName, createArea, examples, getArea, listAreas, mergeAreas, setScope, tagsOf, updateArea } from "../src/store/areas";
import { migrate, type Sql } from "../src/store/db";
import { append, get as getRow, thread } from "../src/store/log";
import { createRecord } from "../src/store/records";
import { readSettings } from "../src/store/settings";
import { startRun } from "../src/store/runs";
import { env, fakeCalendar, fakeDecider, fakeEmbedder, say, scripted } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`a-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

function exchange(sql: Sql, said: string, reply = "ok"): { ask: string; answer: string } {
  const runId = startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
  const ask = append(sql, { actor: "owner", kind: "message.in", run_id: runId, surface: "app", body: { text: said } }).id;
  const answer = append(sql, { actor: "atlas", kind: "message.out", run_id: runId, surface: "app", body: { text: reply } }).id;
  return { ask, answer };
}

afterEach(() => {
  seams.makeBrain = null;
  seams.decide = undefined;
  seams.embed = undefined;
  seams.calendar = undefined;
});

describe("tagging", () => {
  it("tags the owner's messages, gives Atlas's reply the same areas, and records follow their source", () =>
    withSql(async (sql) => {
      const work = createArea(sql, { name: "Keyframes", about: "the owner's video studio", by: "owner" });
      createArea(sql, { name: "Home", by: "owner" });
      const a = exchange(sql, "Send the Keyframes invoice to Dana", "Sure.");
      const b = exchange(sql, "what's a good pasta recipe?", "Try cacio e pepe.");
      const rec = createRecord(sql, {
        type: "task",
        name: "Invoice",
        fields: { fact: "Invoice due Friday." },
        source: { via: "chat", log_id: a.ask },
      });
      const pass = await tagPending(sql, fakeDecider({ Keyframes: ["invoice"] }));
      expect(tagsOf(sql, `log:${a.ask}`)).toEqual([work.id]);
      expect(tagsOf(sql, `log:${a.answer}`)).toEqual([work.id]);
      expect(tagsOf(sql, `log:${b.ask}`)).toEqual([]);
      expect(tagsOf(sql, `rec:${rec.id}`)).toEqual([work.id]);
      expect(pass.changed).toEqual([a.ask, a.answer]);
      // Nothing is asked twice.
      const again = await tagPending(sql, fakeDecider());
      expect(again.tagged).toBe(0);
    }));

  it("collects messages that fit no area, and starts the areas the brain finds, once each", () =>
    withSql(async (sql) => {
      const said = ["Leg day at the gym", "Gym was packed", "New gym shoes", "Ran 5k before the gym", "Mom's flight lands at 3"];
      const ids = said.map((t) => exchange(sql, t).ask);
      await tagPending(sql, fakeDecider({}, ["gym", "mom"]));
      expect(unfiled(sql).length).toBe(DISCOVER_AFTER);
      const answer = `Here you go: {"areas": [{"name": "Gym", "about": "workouts", "messages": [1, 2, 3, 4]}, {"name": "Mom", "messages": [5]}]}`;
      const announced = startDiscovered(sql, unfiled(sql), answer, "run_x");
      expect(announced.map((r) => r.body)).toMatchObject([{ change: "started", name: "Gym", from: 4 }]);
      expect(areaByName(sql, "Mom")).toBeNull(); // one message isn't enough
      const gym = areaByName(sql, "Gym")!;
      expect(ids.slice(0, 4).map((id) => tagsOf(sql, `log:${id}`))).toEqual([[gym.id], [gym.id], [gym.id], [gym.id]]);
      expect(unfiled(sql).map((r) => r.id)).toEqual([ids[4]]);
      expect(thread(sql, 50).some((r) => r.kind === "area.change" && r.body.name === "Gym")).toBe(true);
      // Nonsense from the brain changes nothing.
      expect(startDiscovered(sql, unfiled(sql), "no json here", "run_y")).toEqual([]);
    }));
});

describe("tagging when things go wrong", () => {
  it("leaves an item Clef refuses untagged and keeps going", () =>
    withSql(async (sql) => {
      const work = createArea(sql, { name: "Keyframes", by: "owner" });
      const bad = exchange(sql, "x".repeat(50_000));
      const good = exchange(sql, "Keyframes invoice is out");
      const d = fakeDecider({ Keyframes: ["invoice"] });
      const refusing = {
        ...d,
        async yesNo(state: string, q: Parameters<typeof d.yesNo>[1], signal?: AbortSignal) {
          if (state.startsWith("xxx")) throw new Error("Workers AI answered 413: input too long");
          return d.yesNo(state, q, signal);
        },
      };
      await tagPending(sql, refusing);
      expect(tagsOf(sql, `log:${bad.ask}`)).toEqual([]);
      expect(tagsOf(sql, `log:${good.ask}`)).toEqual([work.id]);
      // The long one was cut before it was sent.
      expect(d.calls.every((c) => c.state.length <= 2_000)).toBe(true);
    }));

  it("doesn't rediscover the same set, revive archived areas, or count a message twice", () =>
    withSql(async (sql) => {
      const said = ["Leg day at the gym", "Gym was packed", "New gym shoes", "Ran 5k before the gym", "Mom's flight lands at 3"];
      const ids = said.map((t) => exchange(sql, t).ask);
      await tagPending(sql, fakeDecider({}, ["gym", "mom"]));
      expect(readyToDiscover(sql, unfiled(sql))).toBe(true);
      triedDiscovery(sql, unfiled(sql));
      // Nothing new since the last try: wait.
      expect(readyToDiscover(sql, unfiled(sql))).toBe(false);

      const gym = createArea(sql, { name: "Gym", by: "owner" });
      updateArea(sql, gym.id, { state: "archived" }, "owner");
      expect(startDiscovered(sql, unfiled(sql), `{"areas": [{"name": "Gym", "messages": [1, 2, 3]}]}`, "run_x")).toEqual([]);
      expect(getArea(sql, gym.id)!.state).toBe("archived");
      expect(startDiscovered(sql, unfiled(sql), `{"areas": [{"name": "Solo", "messages": [5, 5, 5]}]}`, "run_y")).toEqual([]);
      expect(areaByName(sql, "Solo")).toBeNull();

      // An existing area takes its messages without being announced as new.
      const fit = createArea(sql, { name: "Fitness", by: "owner" });
      expect(startDiscovered(sql, unfiled(sql), `{"areas": [{"name": "fitness", "messages": [1, 2, 3]}]}`, "run_z")).toEqual([]);
      expect(tagsOf(sql, `log:${ids[0]}`)).toEqual([fit.id]);
      expect(unfiled(sql).map((r) => r.id)).toEqual([ids[3], ids[4]]);
    }));
});

describe("corrections", () => {
  it("move what's related, and teach later tagging", () =>
    withSql(async (sql) => {
      const work = createArea(sql, { name: "Keyframes", by: "owner" });
      const home = createArea(sql, { name: "Home", by: "owner" });
      const a = exchange(sql, "Book the plumber for the studio sink", "Booked.");
      const rec = createRecord(sql, {
        type: "task",
        name: "Plumber",
        fields: { fact: "Plumber Tuesday." },
        source: { via: "chat", log_id: a.ask },
      });
      await tagPending(sql, fakeDecider({ Home: ["plumber"] }));
      expect(tagsOf(sql, `log:${a.ask}`)).toEqual([home.id]);

      const row = correctAreas(sql, `log:${a.ask}`, [work.id]);
      expect(row.body).toMatchObject({ change: "moved", before: [home.id], after: [work.id], related: 2 });
      expect(tagsOf(sql, `log:${a.answer}`)).toEqual([work.id]);
      expect(tagsOf(sql, `rec:${rec.id}`)).toEqual([work.id]);
      expect(examples(sql, work.id)).toEqual([{ text: "Book the plumber for the studio sink", fits: true }]);
      expect(examples(sql, home.id)).toEqual([{ text: "Book the plumber for the studio sink", fits: false }]);

      // The next message like it follows the correction.
      const b = exchange(sql, "The studio sink is leaking again");
      const d = fakeDecider({ Home: ["plumber"] });
      await tagPending(sql, d);
      expect(tagsOf(sql, `log:${b.ask}`)).toEqual([work.id]);
      expect(d.calls[0]!.questions[work.id]).toContain('These belong to Keyframes: "Book the plumber for the studio sink"');
    }));
});

describe("the hat", () => {
  it("is the scope when there is one, else the last tagged message, and brings the area's tone", () =>
    withSql(async (sql) => {
      const work = createArea(sql, { name: "Keyframes", about: "video studio", by: "owner" });
      updateArea(sql, work.id, { settings: { tone: "formal with clients" } }, "owner");
      const home = createArea(sql, { name: "Home", by: "owner" });
      exchange(sql, "fix the sink at home");
      await tagPending(sql, fakeDecider());
      expect(hat(sql).map((a) => a.name)).toEqual(["Home"]);
      setScope(sql, work.id);
      expect(hat(sql).map((a) => a.name)).toEqual(["Keyframes"]);
      const prompt = systemPrompt({ settings: readSettings(sql), tz: "UTC", now: new Date(), surface: "app", sql });
      expect(prompt).toContain("You're acting in Keyframes (video studio). Tone here: formal with clients.");
      expect(prompt).toContain("The owner's areas: Keyframes, Home.");
      expect(getArea(sql, home.id)!.state).toBe("active");
    }));

  it("merges two areas into one, keeping every tag", () =>
    withSql(async (sql) => {
      const gym = createArea(sql, { name: "Gym", by: "atlas" });
      const run = createArea(sql, { name: "Running", by: "atlas" });
      const a = exchange(sql, "gym today");
      correctAreas(sql, `log:${a.ask}`, [run.id]);
      mergeAreas(sql, run.id, gym.id, "owner");
      expect(tagsOf(sql, `log:${a.ask}`)).toEqual([gym.id]);
      expect(getArea(sql, run.id)!.state).toBe("archived");
      expect(listAreas(sql).map((x) => x.name)).toEqual(["Gym"]);
    }));
});

describe("in the agent", () => {
  it("tags after a run, takes corrections from the app, and uses the area's tone", async () => {
    const b = scripted([say("Sent."), say("Got it.")], "chatgpt", "gpt-5.6-terra");
    seams.makeBrain = () => b.brain;
    seams.decide = fakeDecider({ Keyframes: ["invoice"] });
    seams.embed = fakeEmbedder();
    seams.calendar = fakeCalendar([]);
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`aa-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      const work = createArea(sql, { name: "Keyframes", by: "owner" });
      updateArea(sql, work.id, { settings: { tone: "brisk" } }, "owner");
      const out = await agent.apiTurn("send the invoice");
      await agent.apiSettleMemory();
      const asked = sql.exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? AND kind = 'message.in'`, out.run_id).one().id;
      expect(getRow(sql, asked)!.areas).toEqual([work.id]);
      // The next run wears that hat.
      await agent.apiTurn("and cc Dana");
      expect(b.requests[1]!.system).toContain("Tone here: brisk.");
    });
  });
});
