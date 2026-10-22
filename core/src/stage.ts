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

export const StageView = z.discriminatedUnion("kind", [AreaStage, PersonStage, ListStage, TableStage, AutomationStage]);
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
  made_by: "owner" | "atlas";
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

/** What a view needs from the agent, or why it can't be shown any more. */
export type StagePage = AreaPage | PersonPage | AutomationPage | { kind: "missing"; why: string };

/** The few words a view goes by: on its tab, its receipt and its compact card. */
export function stageTitle(v: StageView, names: { area?: string; person?: string; automation?: string } = {}): string {
  switch (v.kind) {
    case "area":
      return names.area ?? v.area;
    case "person":
      return names.person ?? v.person;
    case "list":
    case "table":
      return v.title;
    case "automation":
      return names.automation ?? v.automation;
  }
}
