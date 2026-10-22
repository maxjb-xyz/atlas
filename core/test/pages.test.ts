import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { undoReceipt } from "../src/agent/undo";
import { pagePage, stagePage } from "../src/agent/views";
import { bodyOf, findPage, pageVersion, savePage, segments, viewBlock } from "../src/pages";
import type { PagePage } from "../src/stage";
import { createArea } from "../src/store/areas";
import { migrate, type Sql } from "../src/store/db";
import { append } from "../src/store/log";
import { readSettings } from "../src/store/settings";
import { startRun } from "../src/store/runs";
import { pageRead, pageSave } from "../src/tools/pages";
import { show } from "../src/tools/show";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types";
import { env } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`p-${crypto.randomUUID()}`));
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
  };
}

async function use(tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> {
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.message);
  return tool.run(parsed.data as never, c);
}
const error = (r: ToolResult) => (r.output as { error: string }).error;

/** A receipt in the log, the way the loop saves a tool's result, so Undo can find it. */
const saveReceipt = (sql: Sql, r: ToolResult) =>
  append(sql, { actor: "atlas", kind: "tool.result", body: { ok: r.ok, receipt: r.receipt as never } }).id;

describe("pages", () => {
  it("are text with views kept in them; area views point at the area, lists keep what they said", () =>
    withSql(async (sql) => {
      const area = createArea(sql, { name: "Keyframes", about: "My video studio", by: "owner" });
      const body = [
        "# Riverside shoot",
        "Saturday at the river. Bring the long lens.",
        "```view",
        JSON.stringify({ kind: "area", area: "Keyframes" }),
        "```",
        "```view",
        JSON.stringify({ kind: "list", title: "Gear", items: [{ text: "Long lens" }, { text: "Two batteries" }] }),
        "```",
        "Call Jordan Friday.",
      ].join("\n");
      const made = await use(pageSave, { name: "Riverside shoot plan", body, note: "Made" }, ctx(sql));
      expect(made.receipt).toMatchObject({
        text: "Made page · Riverside shoot plan",
        view: { kind: "page" },
        undo: { kind: "page.undo", version: 1 },
      });
      const page = findPage(sql, "riverside shoot plan")!;
      const opened = stagePage(sql, { kind: "page", page: page.id }) as PagePage;
      expect(opened.page.segments.map((s) => s.kind)).toEqual(["text", "view", "view", "text"]);
      // The area view was saved by id, so it follows renames.
      expect(opened.page.segments[1]).toEqual({ kind: "view", view: { kind: "area", area: area.id } });
      // The owner's own words, and Atlas's, round-trip through the body.
      expect(bodyOf(segments(pageVersion(sql, page.id)!.body))).toBe(pageVersion(sql, page.id)!.body);

      const read = await use(pageRead, { page: "Riverside shoot plan" }, ctx(sql));
      expect((read.output as { body: string }).body).toContain('"kind":"list"');
      expect(error(await use(pageSave, { name: "Another", body: "```view\n{not json}\n```", note: "x" }, ctx(sql)))).toContain(
        "didn't read as a view",
      );
      expect(
        error(await use(pageSave, { name: "Zebra", body: viewBlock({ kind: "area", area: "Zebra" }), note: "x" }, ctx(sql))),
      ).toContain("The owner's areas are: Keyframes");
      expect(error(await use(pageSave, { name: "Riverside shoot plan", body: "x", note: "x" }, ctx(sql)))).toContain(
        "already a page called",
      );
    }));

  it("keep every version, can bring one back, and Undo goes back one", () =>
    withSql(async (sql) => {
      const first = await use(pageSave, { name: "Weekly report", body: "Week one.", note: "Made" }, ctx(sql));
      const id = findPage(sql, "Weekly report")!.id;
      const second = await use(pageSave, { page: "Weekly report", name: "Weekly report", body: "Week two.", note: "Refreshed" }, ctx(sql));
      expect(second.receipt?.text).toBe("Changed page · Weekly report · version 2");
      // The same body again changes nothing.
      expect(await use(pageSave, { page: id, name: "Weekly report", body: "Week two.", note: "Again" }, ctx(sql))).toMatchObject({
        output: { unchanged: true },
      });
      const old = pagePage(sql, id, 1) as PagePage;
      expect(old.page).toMatchObject({ version: 2, shown: { n: 1, note: "Made", by: "atlas" } });
      expect(old.page.versions.map((v) => v.n)).toEqual([2, 1]);

      const clock = { schedule: async () => {}, unschedule: async () => {} };
      // Undo of an older version is refused: the page changed since.
      expect(await undoReceipt(sql, saveReceipt(sql, first), clock)).toMatchObject({ ok: false });
      expect(await undoReceipt(sql, saveReceipt(sql, second), clock)).toMatchObject({ ok: true });
      expect(pageVersion(sql, id)).toMatchObject({ n: 3, body: "Week one.", note: "Undid version 2", by: "owner" });

      savePage(sql, { id, name: "Weekly report", body: "Mine now.", note: "Edited", by: "owner" });
      expect(pageVersion(sql, id)).toMatchObject({ n: 4, by: "owner" });
    }));

  it("go on the stage by name, and a missing one says which there are", () =>
    withSql(async (sql) => {
      savePage(sql, { name: "Trip plan", body: "Lisbon in May.", note: "Made", by: "owner" });
      const shown = await use(show, { view: { kind: "page", page: "trip plan" } }, ctx(sql));
      expect(shown.receipt).toMatchObject({ text: "Showing · Trip plan", view: { kind: "page", page: findPage(sql, "Trip plan")!.id } });
      expect(error(await use(show, { view: { kind: "page", page: "Ski trip" } }, ctx(sql)))).toContain("The owner's pages are: Trip plan");
      // Drafts and plans go on the stage as they are.
      const draft = await use(
        show,
        { view: { kind: "draft", title: "Email to the landlord", text: "Hi Sam, the sink still leaks." } },
        ctx(sql),
      );
      expect(draft.receipt?.text).toBe("Showing · Email to the landlord");
      const plan = await use(
        show,
        {
          view: {
            kind: "plan",
            title: "Riverside",
            steps: [
              { text: "Book the van", state: "done" },
              { text: "Get the quote", when: "Friday" },
            ],
          },
        },
        ctx(sql),
      );
      expect((plan.receipt?.view as { steps: Array<{ state: string }> }).steps.map((s) => s.state)).toEqual(["done", "todo"]);
    }));
});
