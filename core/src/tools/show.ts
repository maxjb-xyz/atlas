// The stage's one tool (§21.6): Atlas puts a view on the stage by filling
// that view's contract. The view is saved on this call's receipt in the log,
// so the console's receipt opens it and a refresh still has it.

import { z } from "zod";
import { areaPage, personPage } from "../agent/views";
import { type StageView, StageView as StageViewSchema, stageTitle } from "../stage";
import { findAutomation } from "../automations";
import { findPage, listPages, pageVersion } from "../pages";
import { getArea, listAreas } from "../store/areas";
import { findRecords, getRecord, recordsNamed } from "../store/records";
import { defineTool, fail, type ToolResult } from "./types";

export const show = defineTool({
  name: "show",
  kind: "look",
  description: [
    "Put a view on the stage of the owner's app, beside your reply.",
    "Use it when the owner asks to see something, when they ask what's going on with one of their areas or who someone is, and when the answer is several items that read better as a list or a table than as sentences.",
    "Views: `area` (an area's page: what it is, its people, plans and recent conversation), `person` (what you know about someone), `automation` (one of the owner's automations, as When → Do → Report with its runs), `page` (one of the owner's kept pages), `list` and `table` (things you've put together in this turn), `draft` (words for the owner to copy and send themselves, such as an email or a post), `plan` (steps toward something, each with whether it's to do, under way, done or waiting) `research` (an answer from the web, with the sources you searched or read) and `browser` (your browser, live).",
    "Fill a list, table or research view only with what you've looked up or what's in the conversation, never with guesses, and say where it came from in `source` (for research, in its `sources`).",
    "The owner sees the view as you answer, so keep your reply to what matters most and don't read the view out. In a voice conversation, say a sentence or two and let the stage show the rest.",
  ].join(" "),
  input: z.object({ view: StageViewSchema }),
  async run({ view }, ctx) {
    const shown = resolve(ctx.sql, view);
    if ("error" in shown) return fail(shown.error);
    const name = stageTitle(shown.view, shown.names);
    const out: ToolResult = {
      ok: true,
      output: { shown: shown.view.kind, title: name, ...(shown.what ? { on_the_stage: shown.what } : {}) },
      receipt: { text: `Showing · ${name}`, view: shown.view },
    };
    return out;
  },
});

type Resolved =
  { view: StageView; names: { area?: string; person?: string; automation?: string; page?: string }; what?: unknown } | { error: string };

/** Turns a name into the id the view keeps, and checks a table's rows fit its columns. Pages use it for the views they keep. */
export function resolve(sql: Parameters<typeof getArea>[0], view: StageView): Resolved {
  switch (view.kind) {
    case "area": {
      const all = listAreas(sql, { all: true });
      const want = view.area.trim().toLowerCase();
      const a = getArea(sql, view.area) ?? all.find((x) => x.name.toLowerCase() === want && x.state !== "archived");
      if (!a) {
        const names = all.filter((x) => x.state !== "archived").map((x) => x.name);
        return {
          error: names.length
            ? `There's no area called "${view.area}". The owner's areas are: ${names.join(", ")}.`
            : `There's no area called "${view.area}"; the owner has no areas yet.`,
        };
      }
      const page = areaPage(sql, a.id);
      if (page.kind === "missing") return { error: page.why };
      if (page.kind !== "area") return { error: "That isn't an area." };
      return { view: { kind: "area", area: a.id }, names: { area: a.name }, what: areaSummary(page) };
    }
    case "person": {
      const byId = getRecord(sql, view.person);
      const p =
        byId?.type === "person" && byId.state === "active"
          ? byId
          : (findRecords(sql, "person", view.person)[0] ??
            (() => {
              const close = recordsNamed(sql, view.person, 5).filter((r) => r.type === "person");
              return close.length === 1 ? close[0] : null;
            })());
      if (!p)
        return { error: `You don't have anyone called "${view.person}" in what you know. Look them up with recall, or save them first.` };
      const page = personPage(sql, p.id);
      if (page.kind !== "person") return { error: page.kind === "missing" ? page.why : "That isn't a person." };
      return {
        view: { kind: "person", person: p.id },
        names: { person: p.name },
        what: {
          fact: page.person.fact,
          details: page.person.details,
          linked: page.links.map((l) => `${l.record.name} (${l.kind.replace("_", " ")})`),
          mentioned: page.mentions.length,
        },
      };
    }
    case "table": {
      const bad = view.rows.findIndex((r) => r.length !== view.columns.length);
      if (bad >= 0) {
        return {
          error: `Row ${bad + 1} has ${view.rows[bad]!.length} cells, but there are ${view.columns.length} columns. Give every row one cell per column, with null for an empty one.`,
        };
      }
      return { view, names: {} };
    }
    case "list":
    case "draft":
    case "plan":
    case "research":
    case "browser":
      return { view, names: {} };
    case "page": {
      const p = findPage(sql, view.page);
      if (!p) {
        const names = listPages(sql).map((x) => x.name);
        return {
          error: names.length
            ? `There's no page called "${view.page}". The owner's pages are: ${names.slice(0, 30).join(", ")}.`
            : `There's no page called "${view.page}"; the owner has no pages yet.`,
        };
      }
      if (view.version && !pageVersion(sql, p.id, view.version)) return { error: `${p.name} has no version ${view.version}.` };
      return { view: { kind: "page", page: p.id, ...(view.version ? { version: view.version } : {}) }, names: { page: p.name } };
    }
    case "automation": {
      const a = findAutomation(sql, view.automation);
      if (!a) return { error: `There's no automation called "${view.automation}".` };
      return { view: { kind: "automation", automation: a.id }, names: { automation: a.name } };
    }
  }
}

/** What the model learns from showing an area, so it can talk about it without looking again. */
function areaSummary(page: Extract<ReturnType<typeof areaPage>, { kind: "area" }>) {
  const brief = (rs: typeof page.people) => rs.slice(0, 10).map((r) => (r.fact ? `${r.name}: ${r.fact}` : r.name));
  return {
    about: page.area.about,
    people: brief(page.people),
    plans: brief(page.plans),
    places: brief(page.places),
    notes: brief(page.notes),
    recent: page.recent.slice(0, 6).map((m) => `${m.by === "owner" ? "The owner" : "You"}: ${m.text.slice(0, 200)}`),
  };
}
