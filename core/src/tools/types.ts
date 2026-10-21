// A tool is a narrow hand (§9.1). Its description is part of how Atlas
// behaves: when Atlas misuses a tool, fix the description or the tool, never
// add a filter around the model (rule 1).

import { z } from "zod";
import type { ToolSpec } from "../brains/types";
import type { Embedder } from "../brains/embed";
import type { CalendarSource } from "../calendar/types";
import type { AgendaItem } from "../store/agenda";
import type { Sql } from "../store/db";
import type { Receipt } from "../store/log";
import type { Settings } from "../store/settings";

/** What kind of action a tool takes decides when Atlas asks first (§12.1). */
export type ToolKind = "look" | "change_own";

export interface ToolContext {
  sql: Sql;
  run_id: string;
  settings: Settings;
  tz: string;
  now: Date;
  /** The calendar sense, or null when it isn't connected. */
  calendar: CalendarSource | null;
  /** The `embed` role, for meaning search; null when there isn't one. */
  embed: Embedder | null;
  /** The owner's message that started this run, so saved records can point back to it. */
  source_log_id: string | null;
  /** The one scheduler (§4.3): wakes an agenda item at its time. */
  clock: {
    schedule(item: AgendaItem): Promise<void>;
    unschedule(item: AgendaItem): Promise<void>;
  };
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

export function toSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: schema };
}

/** Plain-words failure the model can act on. */
export const fail = (message: string): ToolResult => ({ ok: false, output: { error: message } });
