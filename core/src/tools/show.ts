// The stage's one tool (§21.6): Atlas puts a view on the stage by filling
// that view's contract. The view is saved on this call's receipt in the log,
// so the console's receipt opens it and a refresh still has it.

import { z } from "zod";
import { areaPage, personPage } from "../agent/views";
import { type StageView, StageView as StageViewSchema, stageTitle } from "../stage";
import { findAutomation } from "../automations";
import { findPage, listPages, pageVersion } from "../pages";
import { findFile, listFiles } from "../files";
import { getApp } from "../mcp";
import { getArea, listAreas } from "../store/areas";
import { findRecords, getRecord, recordsNamed } from "../store/records";
import { defineTool, fail, type ToolResult } from "./types";
import { here, pinOf } from "../location";

export const show = defineTool({
  name: "show",
  kind: "look",
  description: [
    "Put a view on the stage of the owner's app, beside your reply.",
    "Use it when the owner asks to see something, when they ask what's going on with one of their areas or who someone is, and when the answer is several items that read better as a list or a table than as sentences.",
    "Views: `area` (an area's page: what it is, its people, plans and recent conversation), `person` (what you know about someone), `automation` (one of the owner's automations, as When → Do → Report with its runs), `page` (one of the owner's kept pages), `list` and `table` (things you've put together in this turn), `draft` (words for the owner to copy and send themselves, such as an email or a post), `plan` (steps toward something, each with whether it's to do, under way, done or waiting) `research` (an answer from the web, with the sources you searched or read), `browser` (your browser, live), `file` (one of the files you made, to look at and download), `document` (a longer write-up to read, in Markdown), `code` (code, with its language), `chart` (bars or lines of numbers you have), `compare` (options side by side on what matters, with your pick), `kit` (a layout of parts: text, headline stats, a list, a table, a chart, a compare), `app` (a small interactive HTML app, sandboxed with no network, for things like a checklist or a calculator), `map` (saved places marked on a map; for a route, use route with show: true), `place` (a saved place: its details, a map and the owner's visits), `weather` (the weather near the owner, hour by hour), `situation` (where the owner is, what's next and when to leave, weather and devices) and `senses` (what your senses took in today and what you decided: the funnel, each source's state, what's waiting for a look).",
    "A view isn't a file: when the owner asks for a spreadsheet or a document to keep or download, make a file (file_save, or the workspace for .xlsx, .docx or PDF), which opens on the stage by itself.",
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
  | {
      view: StageView;
      names: { area?: string; person?: string; automation?: string; page?: string; file?: string; place?: string };
      what?: unknown;
    }
  | { error: string };

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
      const error = tableProblem(view);
      return error ? { error } : { view, names: {} };
    }
    case "list":
    case "draft":
    case "plan":
    case "research":
    case "browser":
    case "workspace":
    case "document":
    case "code":
    case "app":
      return { view, names: {} };
    case "mcp_app":
      return getApp(sql, view.call)
        ? { view, names: {} }
        : { error: "That page isn't kept any more. Call its tool again with mcp_call to show it." };
    case "chart":
    case "compare": {
      const error = view.kind === "chart" ? chartProblem(view) : compareProblem(view);
      return error ? { error } : { view, names: {} };
    }
    case "kit": {
      for (const b of view.blocks) {
        const error =
          b.type === "chart" ? chartProblem(b) : b.type === "compare" ? compareProblem(b) : b.type === "table" ? tableProblem(b) : null;
        if (error) return { error: `In the ${b.type}${"title" in b && b.title ? ` "${b.title}"` : ""}: ${error}` };
      }
      return { view, names: {} };
    }
    case "file": {
      const f = findFile(sql, view.file);
      if (!f) {
        const names = listFiles(sql).map((x) => x.name);
        return {
          error: names.length
            ? `There's no file called "${view.file}". Your files are: ${names.slice(0, 30).join(", ")}.`
            : `There's no file called "${view.file}"; you haven't made any files yet.`,
        };
      }
      return { view: { kind: "file", file: f.id }, names: { file: f.name } };
    }
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
    case "weather":
    case "situation":
    case "senses":
      return { view, names: {} };
    case "place": {
      const r = savedPlaceOf(sql, view.place);
      if (!r) return { error: `There's no saved place called "${view.place}". Save it with remember, and pin it with place_pin.` };
      return { view: { kind: "place", place: r.id }, names: { place: r.name } };
    }
    case "map": {
      // A route's map comes filled from the route tool; one from show marks saved places.
      if (view.markers?.length) return { view, names: {} };
      const markers: Array<{ name: string; lat: number; lon: number; here?: boolean }> = [];
      for (const name of view.places ?? []) {
        if (/^(here|me|my location)$/i.test(name.trim())) {
          const f = here(sql).fix;
          if (!f) return { error: "Atlas doesn't know where the owner is (no location yet, or it's off), so 'here' can't be marked." };
          markers.push({ name: "You", lat: f.lat, lon: f.lon, here: true });
          continue;
        }
        const r = savedPlaceOf(sql, name);
        const pin = r ? pinOf(r) : null;
        if (!pin) {
          return {
            error: r
              ? `${r.name} isn't pinned on the map yet. Pin it with place_pin (from its address), then show the map.`
              : `There's no saved place called "${name}". To show an address, pin it as a place first, or use route with show: true.`,
          };
        }
        markers.push({ name: pin.name, lat: pin.lat, lon: pin.lon });
      }
      if (!markers.length) return { error: "Give the map at least one place to mark." };
      return { view: { ...view, markers }, names: {} };
    }
  }
}

function savedPlaceOf(sql: Parameters<typeof getArea>[0], ref: string) {
  const r = getRecord(sql, ref);
  if (r && r.state === "active" && (r.type === "place" || r.type === "organization")) return r;
  return findRecords(sql, "place", ref)[0] ?? findRecords(sql, "organization", ref)[0] ?? null;
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

const chartProblem = (c: { x: string[]; series: Array<{ name: string; values: unknown[] }> }) => {
  const bad = c.series.find((s) => s.values.length !== c.x.length);
  return bad
    ? `${bad.name} has ${bad.values.length} values, but there are ${c.x.length} x labels. Give each series one value per x, with null for none.`
    : null;
};

const compareProblem = (c: { options: Array<{ name: string }>; rows: Array<{ label: string; values: unknown[] }>; pick?: string }) => {
  const bad = c.rows.find((r) => r.values.length !== c.options.length);
  if (bad) return `${bad.label} has ${bad.values.length} values, but there are ${c.options.length} options. Give one per option, in order.`;
  if (c.pick && !c.options.some((o) => o.name === c.pick)) return `The pick "${c.pick}" isn't one of the options' names.`;
  return null;
};

const tableProblem = (t: { columns: string[]; rows: unknown[][] }) => {
  const bad = t.rows.findIndex((r) => r.length !== t.columns.length);
  return bad >= 0
    ? `Row ${bad + 1} has ${t.rows[bad]!.length} cells, but there are ${t.columns.length} columns. Give every row one cell per column, with null for an empty one.`
    : null;
};
