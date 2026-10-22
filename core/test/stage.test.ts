import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { areaPage, personPage } from "../src/agent/views";
import { StageView } from "../src/stage";
import { createArea, mergeAreas, setTags } from "../src/store/areas";
import { migrate, type Sql } from "../src/store/db";
import { append } from "../src/store/log";
import { createRecord, forgetRecord, link } from "../src/store/records";
import { readSettings } from "../src/store/settings";
import { startRun } from "../src/store/runs";
import { show } from "../src/tools/show";
import { type ToolContext, type ToolResult, toSpec } from "../src/tools/types";
import { env } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`s-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

function ctx(sql: Sql): ToolContext {
  return {
    sql,
    run_id: startRun(sql, { actor: "owner", trigger: "message", surface: "app", role: "main" }),
    settings: readSettings(sql),
    tz: "America/New_York",
    now: new Date(),
    calendar: null,
    clock: { schedule: async () => {}, unschedule: async () => {} },
    embed: null,
    source_log_id: null,
    via: "chat",
    helpers: null,
    exit: null,
    automations: null,
    web: null,
    browser: null,
  };
}

const run = (input: unknown, c: ToolContext): Promise<ToolResult> => {
  const parsed = show.input.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.message);
  return show.run(parsed.data as never, c);
};
const error = (r: ToolResult) => (r.output as { error: string }).error;

/** Keyframes, with Jordan in it, a goal, and a message about it. */
function keyframes(sql: Sql) {
  const area = createArea(sql, { name: "Keyframes", about: "My video studio", by: "owner" });
  const jordan = createRecord(sql, {
    type: "person",
    name: "Jordan",
    fields: { fact: "Runs Keyframes with Max." },
    source: { via: "chat" },
  });
  const goal = createRecord(sql, { type: "goal", name: "Riverside shoot", fields: { fact: "Shoot on Oct 30." }, source: { via: "chat" } });
  link(sql, jordan.id, goal.id, "works_with");
  setTags(sql, `rec:${jordan.id}`, [area.id]);
  setTags(sql, `rec:${goal.id}`, [area.id]);
  const said = append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text: "Jordan booked the Riverside location" } });
  setTags(sql, `log:${said.id}`, [area.id]);
  append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text: "Nothing to do with work" } });
  return { area, jordan, goal };
}

describe("show", () => {
  it("gives every provider a plain object at the top of its parameters", () => {
    const spec = toSpec(show);
    expect(spec.parameters).toMatchObject({ type: "object", required: ["view"] });
    expect(JSON.stringify(spec.parameters)).toContain('"area"');
  });

  it("puts an area on the stage by name, saves its id on the receipt, and tells the model what's there", () =>
    withSql(async (sql) => {
      const { area } = keyframes(sql);
      const r = await run({ view: { kind: "area", area: "keyframes" } }, ctx(sql));
      expect(r.ok).toBe(true);
      expect(r.receipt).toEqual({ text: "Showing · Keyframes", view: { kind: "area", area: area.id } });
      expect(r.output).toMatchObject({
        shown: "area",
        title: "Keyframes",
        on_the_stage: {
          about: "My video studio",
          people: ["Jordan: Runs Keyframes with Max."],
          plans: ["Riverside shoot: Shoot on Oct 30."],
          recent: ["The owner: Jordan booked the Riverside location"],
        },
      });
      // What's saved is a view the app can render from.
      expect(StageView.safeParse(r.receipt!.view).success).toBe(true);
    }));

  it("names the areas there are when asked for one that isn't", () =>
    withSql(async (sql) => {
      keyframes(sql);
      const r = await run({ view: { kind: "area", area: "Zebra" } }, ctx(sql));
      expect(r.ok).toBe(false);
      expect(error(r)).toBe(`There's no area called "Zebra". The owner's areas are: Keyframes.`);
    }));

  it("finds a person by id, by name, or by part of a name when only one fits", () =>
    withSql(async (sql) => {
      const { jordan } = keyframes(sql);
      for (const person of [jordan.id, "jordan", "Jord"]) {
        const r = await run({ view: { kind: "person", person } }, ctx(sql));
        expect(r.receipt).toEqual({ text: "Showing · Jordan", view: { kind: "person", person: jordan.id } });
        expect(r.output).toMatchObject({ on_the_stage: { linked: ["Riverside shoot (works with)"] } });
      }
      expect(error(await run({ view: { kind: "person", person: "Sam" } }, ctx(sql)))).toContain(`You don't have anyone called "Sam"`);
    }));

  it("shows lists and tables as given, and refuses a row that doesn't fit the columns", () =>
    withSql(async (sql) => {
      const list = { kind: "list", title: "Decisions", items: [{ text: "Shoot on the 30th" }], source: "What you said in October" };
      expect((await run({ view: list }, ctx(sql))).receipt).toEqual({ text: "Showing · Decisions", view: list });
      const table = {
        kind: "table",
        title: "Lenses",
        columns: ["Lens", "Price"],
        rows: [
          ["35mm", 40],
          ["50mm", null],
        ],
      };
      expect((await run({ view: table }, ctx(sql))).receipt).toEqual({ text: "Showing · Lenses", view: table });
      const bad = await run({ view: { ...table, rows: [["35mm", 40, "extra"]] } }, ctx(sql));
      expect(error(bad)).toBe(
        "Row 1 has 3 cells, but there are 2 columns. Give every row one cell per column, with null for an empty one.",
      );
    }));
});

describe("the stage's pages", () => {
  it("builds an area's page live from its records and messages", () =>
    withSql((sql) => {
      const { area, jordan, goal } = keyframes(sql);
      const page = areaPage(sql, area.id);
      expect(page).toMatchObject({
        kind: "area",
        area: { name: "Keyframes", about: "My video studio" },
        people: [{ id: jordan.id }],
        plans: [{ id: goal.id }],
        places: [],
        recent: [{ by: "owner", text: "Jordan booked the Riverside location" }],
        counts: { messages: 1, records: 2 },
      });
      // A forgotten record leaves the page.
      forgetRecord(sql, goal.id, { via: "owner" });
      expect(areaPage(sql, area.id)).toMatchObject({ plans: [] });
    }));

  it("says so when an area was merged away or a person forgotten", () =>
    withSql((sql) => {
      const { area, jordan } = keyframes(sql);
      const work = createArea(sql, { name: "Work", by: "owner" });
      mergeAreas(sql, area.id, work.id, "owner");
      expect(areaPage(sql, area.id)).toEqual({ kind: "missing", why: "Keyframes was merged into Work." });
      forgetRecord(sql, jordan.id, { via: "owner" });
      expect(personPage(sql, jordan.id)).toEqual({ kind: "missing", why: "You asked Atlas to forget Jordan." });
    }));

  it("builds a person's page with their links and where they came up", () =>
    withSql((sql) => {
      const { jordan, goal } = keyframes(sql);
      const page = personPage(sql, jordan.id);
      expect(page).toMatchObject({
        kind: "person",
        person: { name: "Jordan", fact: "Runs Keyframes with Max." },
        links: [{ kind: "works_with", record: { id: goal.id } }],
        mentions: [{ text: "Jordan booked the Riverside location" }],
        history: [],
      });
    }));
});
