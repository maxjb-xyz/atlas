// A tool is a narrow hand (§9.1). Its description is part of how Atlas
// behaves: when Atlas misuses a tool, fix the description or the tool, never
// add a filter around the model (rule 1).

import { z } from "zod";
import type { Action, ToolKind } from "../approvals";
import type { ToolSpec } from "../brains/types";
import type { Embedder } from "../brains/embed";
import type { Calendar } from "../calendar/types";
import type { AgendaItem } from "../store/agenda";
import type { Sql } from "../store/db";
import type { Receipt } from "../store/log";
import type { Settings } from "../store/settings";

/** What kind of action a tool takes decides when Atlas asks first (§12.1). */
export type { ToolKind } from "../approvals";

export interface ToolContext {
  sql: Sql;
  run_id: string;
  settings: Settings;
  tz: string;
  now: Date;
  /** The calendar sense, or null when it isn't connected. */
  calendar: Calendar | null;
  /** The `embed` role, for meaning search; null when there isn't one. */
  embed: Embedder | null;
  /** The owner's message that started this run, so saved records can point back to it. */
  source_log_id: string | null;
  /** How this run came to be, in plain words, for the sources of what it saves: "chat", "voice", "compaction". */
  via: string;
  /** Hands work to a helper (§8.1); null where helpers aren't allowed, such as inside a helper. */
  helpers: HelperDeskApi | null;
  /**
   * The way out for actions that may need the owner's OK (§12): the outbox
   * does it now when the kind allows, or it waits as an approval card. Null
   * where nothing may leave, such as inside a helper.
   */
  exit: ExitApi | null;
  /** The one scheduler (§4.3): wakes an agenda item at its time. */
  clock: {
    schedule(item: AgendaItem): Promise<void>;
    unschedule(item: AgendaItem): Promise<void>;
  };
}

export interface ExitApi {
  /** Does the action now if its kind and earned trust allow, or adds it to this run's approval card. */
  request(action: Action, ctx: { run_id: string; source_log_id: string | null }): Promise<ToolResult>;
  /** The owner's yes or no to a waiting approval, given by voice or text. */
  decide(id: string, yes: boolean, by: "voice" | "chat"): Promise<{ ok: boolean; text: string }>;
}

export interface HelperDeskApi {
  /** Starts a job; `asked_in` is the run that asked. Throws, with the reason, if the helper can't start. */
  start(o: { title: string; brief: string; tools: string[]; asked_in: string }): Promise<{ id: string }>;
  /** The job's result, or null if it's still running after `ms` (it's then reported when it ends). */
  wait(id: string, ms: number): Promise<{ state: "done" | "failed" | "cancelled"; text: string; error?: string } | null>;
}

export interface ToolResult {
  ok: boolean;
  /** What the model sees. */
  output: unknown;
  /** The chip in the console. Only for things the owner should see happened. */
  receipt?: Receipt;
}

export interface Tool {
  name: string;
  description: string;
  kind: ToolKind;
  input: z.ZodType;
  /** Said or shown while it runs, when Atlas hasn't said anything yet ("Checking your calendar"). */
  status?: string;
  timeoutMs?: number;
  run(input: never, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  kind: ToolKind;
  input: S;
  status?: string;
  timeoutMs?: number;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}): Tool {
  return t as unknown as Tool;
}

/**
 * The tool as brains see it. Fields with defaults are optional (the input
 * side of the schema), and `propertyNames`, which some providers refuse, is
 * left out; the tool still checks its input in full.
 */
export function toSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: withoutPropertyNames(schema) as Record<string, unknown> };
}

function withoutPropertyNames(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutPropertyNames);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== "propertyNames") out[k] = withoutPropertyNames(x);
  return out;
}

/** Plain-words failure the model can act on. */
export const fail = (message: string): ToolResult => ({ ok: false, output: { error: message } });
