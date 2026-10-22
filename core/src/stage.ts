// The stage's views (§21.6). Each view has one typed contract: the model
// fills it as `show`'s input, the agent saves it in the log, and the app
// renders from the same type (§19.4). Area and person views point at what
// Atlas knows, so they stay current; list and table carry what Atlas put
// together in that turn, with where it came from.

import { z } from "zod";
import type { RecordView } from "./protocol";

const source = z
  .string()
  .max(200)
  .optional()
  .describe("Where this came from, in a few words the owner sees under it: 'Your calendar, Oct 20 to 26', 'What you said in October'.");

const title = z.string().min(1).max(80).describe("A short title for the view.");

export const AreaStage = z.object({
  kind: z.literal("area"),
  area: z.string().min(1).max(64).describe("The area's name, as in the list of the owner's areas (or its id)."),
});

export const PersonStage = z.object({
  kind: z.literal("person"),
  person: z.string().min(1).max(120).describe("The person's record id, from recall or the standing facts, or their name."),
});

export const ListStage = z.object({
  kind: z.literal("list"),
  title,
  items: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        note: z.string().max(300).optional().describe("A second line: when, where, who or why."),
        done: z.boolean().optional().describe("For a checklist: whether it's done."),
      }),
    )
    .min(1)
    .max(50),
  numbered: z.boolean().optional().describe("True when the order matters: steps, a ranking."),
  source,
});

const Cell = z.union([z.string().max(300), z.number(), z.null()]);

export const TableStage = z.object({
  kind: z.literal("table"),
  title,
  columns: z.array(z.string().min(1).max(40)).min(1).max(8),
  rows: z.array(z.array(Cell).max(8)).min(1).max(100).describe("One array of cells per row, in the same order as columns."),
  source,
});

export const AutomationStage = z.object({
  kind: z.literal("automation"),
  automation: z.string().min(1).max(80).describe("The automation's name or id."),
});

export const DraftStage = z.object({
  kind: z.literal("draft"),
  title,
  for: z.string().max(200).optional().describe("Who or where it's for, in a few words: 'An email to the landlord', 'The Riverside quote'."),
  text: z.string().min(1).max(8_000).describe("The draft itself, ready to copy. Markdown is fine."),
  source,
});

export const PlanStage = z.object({
  kind: z.literal("plan"),
  title,
  steps: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        note: z.string().max(300).optional(),
        when: z.string().max(60).optional().describe("When it happens, in a few words: 'Friday', 'after the quote'."),
        state: z.enum(["todo", "doing", "done", "waiting"]).default("todo").describe("Waiting means it waits on someone or something."),
      }),
    )
    .min(1)
    .max(30),
  source,
});

export const ResearchStage = z.object({
  kind: z.literal("research"),
  title,
  answer: z
    .string()
    .min(1)
    .max(6_000)
    .describe("The answer, in Markdown: the pick or the finding first, then why. Mark claims with their source's number, like [1]."),
  sources: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        url: z.string().url().max(2_000),
        note: z.string().max(300).optional().describe("What this source says or adds, in a line."),
      }),
    )
    .min(1)
    .max(20)
    .describe("Only pages you searched or read in this conversation, numbered in this order."),
});

export const FileStage = z.object({
  kind: z.literal("file"),
  file: z.string().min(1).max(120).describe("The file's name or id."),
});

export const DocumentStage = z.object({
  kind: z.literal("document"),
  title,
  text: z.string().min(1).max(40_000).describe("The document, in Markdown: a write-up, a summary, a study guide, notes to read."),
  source,
});

export const CodeStage = z.object({
  kind: z.literal("code"),
  title,
  language: z.string().max(30).describe("The language, such as python, javascript, bash, sql."),
  code: z.string().min(1).max(40_000),
  source,
});

/** Numbers over a few categories or over time (§21.6): bars or lines, one axis, at most eight series. */
const chartBody = {
  style: z.enum(["bar", "line"]).describe("Bars to compare amounts across categories; lines for change over time."),
  x: z.array(z.string().max(40)).min(1).max(60).describe("The categories or times along the bottom, in order."),
  series: z
    .array(z.object({ name: z.string().min(1).max(40), values: z.array(z.number().nullable()).max(60) }))
    .min(1)
    .max(8)
    .describe("One per thing measured, each with one value per x (null where there's none). Same unit for all: one axis."),
  unit: z.string().max(20).optional().describe("What the numbers are: '$', 'km', 'min', '%'."),
};

export const ChartStage = z.object({ kind: z.literal("chart"), title, ...chartBody, source });

/** Options side by side (§21.6): what each is like on what matters, and the pick. */
const compareBody = {
  options: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        note: z.string().max(200).optional(),
        url: z.string().url().max(2_000).optional(),
      }),
    )
    .min(2)
    .max(6),
  rows: z
    .array(z.object({ label: z.string().min(1).max(40), values: z.array(z.union([z.string().max(200), z.number(), z.null()])).max(6) }))
    .min(1)
    .max(20)
    .describe("One per thing that matters (price, distance, hours), with one value per option, in the options' order."),
  pick: z.string().max(60).optional().describe("The option you'd pick, by its name."),
  why: z.string().max(600).optional().describe("Why that one, and the tradeoff, in a sentence or two."),
};

export const CompareStage = z.object({ kind: z.literal("compare"), title, ...compareBody, source });

/** A layout Atlas composes from parts (§21.6: the custom kit), drawn in the current theme. */
export const KitStage = z.object({
  kind: z.literal("kit"),
  title,
  blocks: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string().min(1).max(6_000).describe("Markdown.") }),
        z.object({
          type: z.literal("stats"),
          items: z
            .array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(30), note: z.string().max(80).optional() }))
            .min(1)
            .max(6),
        }),
        z.object({
          type: z.literal("list"),
          title: z.string().max(80).optional(),
          items: ListStage.shape.items,
          numbered: ListStage.shape.numbered,
        }),
        z.object({
          type: z.literal("table"),
          title: z.string().max(80).optional(),
          columns: TableStage.shape.columns,
          rows: TableStage.shape.rows,
        }),
        z.object({ type: z.literal("chart"), title: z.string().max(80).optional(), ...chartBody }),
        z.object({ type: z.literal("compare"), title: z.string().max(80).optional(), ...compareBody }),
      ]),
    )
    .min(1)
    .max(12)
    .describe("The parts, top to bottom: text, stats (a few headline numbers), list, table, chart, compare."),
  source,
});

/** A small app for real interactivity (§21.6, §21.7): sandboxed, no network, its data passed in. */
export const AppStage = z.object({
  kind: z.literal("app"),
  title,
  html: z
    .string()
    .min(20)
    .max(100_000)
    .describe(
      "One HTML document with its own CSS and JavaScript inline. It runs sandboxed with no network: no external scripts, fonts or requests. Use the theme's colors, var(--bg), var(--text), var(--muted), var(--line) and var(--accent), so it fits light and dark.",
    ),
  data: z.unknown().optional().describe("Data the app needs, as JSON: it reads it as window.ATLAS_DATA."),
});

/** An MCP App (§21.6): the page a connected server's tool brings, for one call of it. It appears when the tool is called. */
export const McpAppStage = z.object({
  kind: z.literal("mcp_app"),
  call: z.string().max(64).describe("The `page` id mcp_call gave."),
  title: z.string().max(120),
});

/** Atlas's workspace (§9.1): its terminal, files and recent commands. There's one. */
export const WorkspaceStage = z.object({ kind: z.literal("workspace") });

/** Atlas's browser, live (§9.1): there's one, so the view only says to show it. */
export const BrowserStage = z.object({ kind: z.literal("browser") });

const Marker = z.object({
  name: z.string().max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  here: z.boolean().optional(),
});

/** A map (§21.6): saved places marked, and a route when there is one. Markers and the route are filled by Atlas, not the model. */
export const MapStage = z.object({
  kind: z.literal("map"),
  title,
  places: z
    .array(z.string().min(1).max(120))
    .max(20)
    .optional()
    .describe(
      "Saved places to mark, by name or id, and 'here' for where the owner is. For a route, use the route tool with show: true instead.",
    ),
  markers: z.array(Marker).max(30).optional().describe("Leave out: Atlas fills it from places."),
  route: z
    .object({
      line: z.array(z.tuple([z.number(), z.number()])).max(5_000),
      s: z.number(),
      m: z.number(),
      by: z.enum(["drive", "walk", "bike"]),
      traffic: z.boolean(),
    })
    .optional()
    .describe("Leave out: the route tool fills it."),
});

/** A saved place (§21.6): its details, what Atlas knows, a map, and the owner's visits. */
export const PlaceStage = z.object({
  kind: z.literal("place"),
  place: z.string().min(1).max(120).describe("The saved place's name or id."),
});

/** The weather near the owner (§21.6): now, the next hours, and what matters. */
export const WeatherStage = z.object({ kind: z.literal("weather") });

/** The situation (§10.2, §21.6): where the owner is, what they're doing, what's next and when to leave, weather and devices. */
export const SituationStage = z.object({ kind: z.literal("situation") });

export const PageStage = z.object({
  kind: z.literal("page"),
  page: z.string().min(1).max(80).describe("The page's name or id."),
  version: z.number().int().min(1).optional().describe("An older version to show; leave out for the newest."),
});

export const StageView = z.discriminatedUnion("kind", [
  AreaStage,
  PersonStage,
  ListStage,
  TableStage,
  AutomationStage,
  DraftStage,
  PlanStage,
  PageStage,
  ResearchStage,
  BrowserStage,
  FileStage,
  DocumentStage,
  CodeStage,
  WorkspaceStage,
  ChartStage,
  CompareStage,
  KitStage,
  AppStage,
  McpAppStage,
  MapStage,
  PlaceStage,
  WeatherStage,
  SituationStage,
]);
export type StageView = z.infer<typeof StageView>;
export type StageKind = StageView["kind"];

/** A message from the log, as an area or person page shows it. */
export interface StageMessage {
  id: string;
  at: number;
  by: "owner" | "atlas";
  surface: string | null;
  text: string;
}

/** An area's page, built live from its records and the log (§6.4). */
export interface AreaPage {
  kind: "area";
  area: { id: string; name: string; about: string; state: string; color: number; tone: string };
  people: RecordView[];
  /** Goals, tasks, commitments and events. */
  plans: RecordView[];
  /** Places and organizations. */
  places: RecordView[];
  /** Notes, preferences and documents. */
  notes: RecordView[];
  recent: StageMessage[];
  counts: { messages: number; records: number };
}

/** A person's page: what Atlas knows, where it learned it, and where they come up. */
export interface PersonPage {
  kind: "person";
  person: RecordView;
  links: Array<{ kind: string; record: RecordView }>;
  mentions: StageMessage[];
  history: Array<{ at: number; name: string | null; fact: string; reason: string }>;
}

/** An automation as its card and flow show it (§13.4): When → Do → Report, and its recent runs. */
export interface AutomationView {
  id: string;
  name: string;
  about: string;
  state: "on" | "paused";
  made_by: import("./automations").Maker;
  when: import("./automations").Trigger;
  when_text: string;
  steps: Array<{ step: import("./automations").Step; text: string }>;
  report: "thread" | "inbox" | "silent";
  /** Whether it can be turned on now: Atlas's need a test run since their last change. */
  can_turn_on: boolean;
  tested_at: number | null;
  fails: number;
  paused_why: string | null;
  next_at: number | null;
  runs: Array<{
    id: string;
    at: number;
    why: string;
    test: boolean;
    ok: boolean;
    quiet: boolean;
    text: string;
    error: string | null;
    ms: number | null;
    brain: string | null;
    tokens: number;
    results: Array<{ step: string; ok: boolean; text: string }>;
  }>;
}

export interface AutomationPage {
  kind: "automation";
  automation: AutomationView;
}

/** A page as it opens (§21.7): one version, its body in parts, and the list of versions. */
export interface PagePage {
  kind: "page";
  page: {
    id: string;
    name: string;
    made_by: "owner" | "atlas";
    created_at: number;
    /** The newest version, and the one shown. */
    version: number;
    shown: { n: number; at: number; by: "owner" | "atlas"; note: string };
    segments: import("./pages").Segment[];
    versions: Array<{ n: number; at: number; by: "owner" | "atlas"; note: string }>;
  };
}

/** The browser as its view shows it: where it is, and a live link (§9.1). */
/** What a live view of the browser needs: where it is, and a link the app can show. */
export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  /** A link to watch it live (read-only), or to drive it when the owner has taken it over. */
  live: string | null;
  /** Set while the owner has it: why Atlas handed it over, and when. */
  taken: { why: string; at: number } | null;
  error?: string;
}

export type BrowserStagePage = BrowserState & { kind: "browser" };

/** The workspace as its view shows it: whether it's up, its files, the sites it may reach, and what ran lately. */
export interface WorkspaceStagePage {
  kind: "workspace";
  available: boolean;
  running: boolean;
  /** /workspace, while the container is up (listing never starts it). */
  files: Array<{ path: string; size: number; dir: boolean }> | null;
  sites: string[];
  runs: Array<{ id: string; at: number; command: string; exit: number | null; output: string; error?: string }>;
  error?: string;
}

/** A file Atlas made (§21.7): what it is. Its bytes live in R2. */
export interface FileRow {
  id: string;
  name: string;
  type: string;
  size: number;
  made_by: "owner" | "atlas";
  note: string;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A file as its view shows it: what it is, a link to download it, and a look inside when that's possible. */
export interface FileStagePage {
  kind: "file";
  file: { id: string; name: string; type: string; size: number; made_by: "owner" | "atlas"; note: string; updated_at: number; url: string };
  preview:
    | { kind: "text"; text: string; more: boolean }
    | { kind: "table"; columns: string[]; rows: string[][]; more: boolean }
    | { kind: "image" }
    | { kind: "pdf" }
    | { kind: "none" };
}

/** What a view needs from the agent, or why it can't be shown any more. */
export type StagePage =
  | AreaPage
  | PersonPage
  | AutomationPage
  | PagePage
  | BrowserStagePage
  | FileStagePage
  | WorkspaceStagePage
  | PlacePage
  | WeatherPage
  | SituationPage
  | { kind: "missing"; why: string };

/** A saved place as its view shows it. */
export interface PlacePage {
  kind: "place";
  place: RecordView;
  pin: { lat: number; lon: number; radius_m: number } | null;
  /** Arrivals from the log, newest first, with how long each stay was when it ended. */
  visits: Array<{ at: number; stayed_ms: number | null }>;
  /** Whether the owner is there now. */
  here: boolean;
  credit: string;
}

/** The weather as its view shows it, in the owner's units. */
export interface WeatherPage {
  kind: "weather";
  weather: import("./weather").Weather | null;
  units: "us" | "metric";
  tz: string;
  matters: string[];
  error?: string;
}

/** The situation as its view shows it, and Now on Home reads it (§10.2). */
export interface SituationPage {
  kind: "situation";
  where:
    | { known: false; why: string }
    | {
        known: true;
        place: { name: string; since: number } | null;
        /** Away from saved places: how far from home and the nearest place. */
        away: { home_m: number | null; nearest: { name: string; m: number } | null; left: { name: string; at: number } | null } | null;
        fix_at: number;
        motion: string | null;
        point: { lat: number; lon: number };
      };
  doing: { title: string; until: number } | null;
  focus: { until: number; about: string } | null;
  next: {
    title: string;
    start: number;
    location: string | null;
    travel: { s: number; traffic: boolean; leave_by: number; from: "here" | "home"; at: number } | null;
    travel_error: string | null;
  } | null;
  calendar_error: string | null;
  weather: { line: string; matters: string[]; at: number } | null;
  devices: Array<{ name: string; state: string; online: boolean }>;
  errands: Array<{ id: string; title: string; kind: string | null }>;
  units: "us" | "metric";
  credit: string;
}

/** The few words a view goes by: on its tab, its receipt and its compact card. */
export function stageTitle(
  v: StageView,
  names: { area?: string; person?: string; automation?: string; page?: string; file?: string; place?: string } = {},
): string {
  switch (v.kind) {
    case "file":
      return names.file ?? v.file;
    case "document":
    case "code":
    case "chart":
    case "compare":
    case "kit":
    case "app":
    case "mcp_app":
      return v.title;
    case "browser":
      return "Browser";
    case "map":
      return v.title;
    case "place":
      return names.place ?? v.place;
    case "weather":
      return "Weather";
    case "situation":
      return "Situation";
    case "workspace":
      return "Workspace";
    case "area":
      return names.area ?? v.area;
    case "person":
      return names.person ?? v.person;
    case "list":
    case "table":
    case "draft":
    case "plan":
    case "research":
      return v.title;
    case "automation":
      return names.automation ?? v.automation;
    case "page":
      return names.page ?? v.page;
  }
}
