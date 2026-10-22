// A tool is a narrow hand (§9.1). Its description is part of how Atlas
// behaves: when Atlas misuses a tool, fix the description or the tool, never
// add a filter around the model (rule 1).

import { z } from "zod";
import type { Action, ToolKind } from "../approvals";
import type { Automation } from "../automations";
import type { RunOutcome } from "../agent/automations";
import type { ToolSpec } from "../brains/types";
import type { Embedder } from "../brains/embed";
import type { Calendar } from "../calendar/types";
import type { AgendaItem } from "../store/agenda";
import type { Sql } from "../store/db";
import type { Receipt } from "../store/log";
import type { Settings } from "../store/settings";
import type { LookOut, Page, SearchResult } from "../web";
import type { BrowserAction, BrowserPage, PageElement } from "../browser";
import type { McpServer } from "../mcp";
import type { StageView } from "../stage";

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
  /** The web (§9.1), through the outbox's checks; null where the web isn't reachable. */
  web: WebApi | null;
  /** Where files' bytes live (§21.7): R2, or null where there's no bucket. */
  files: R2Bucket | null;
  /** The tools this run has, for a program that calls them (Code Mode, §9.1). */
  tools?: Tool[];
  /** Runs Code Mode's programs in Dynamic Workers; null where programs can't run. */
  loader?: WorkerLoader | null;
  /** Logs a tool call a program made, with its receipt, as a row of this run. */
  record?: (name: string, input: unknown, result: ToolResult) => Promise<void>;
  /** The workspace (§9.1): a container with a shell; null where it isn't reachable. */
  workspace: WorkspaceApi | null;
  /** The browser (§9.1), for runs that may drive it; null elsewhere. */
  browser: BrowserApi | null;
  /** Connected MCP servers (§9.2); absent or null where they can't be used. */
  mcp?: McpApi | null;
  /** Automations, for owner runs; null elsewhere. */
  automations: AutomationsApi | null;
  /** The one scheduler (§4.3): wakes an agenda item at its time. */
  clock: {
    schedule(item: AgendaItem): Promise<void>;
    unschedule(item: AgendaItem): Promise<void>;
  };
}

/** Running and arming automations, for Atlas's tools (§13). */
export interface AutomationsApi {
  run(automation: Automation, o: { why: "request" | "test"; inputs?: Record<string, string> }): Promise<RunOutcome>;
  /** Puts its next run on the clock, or takes it off, after a change. */
  arm(id: string): Promise<void>;
}

/** Searching and reading the web. Each call leaves Atlas, so it passes the exit checks and leaves a receipt (§4.4). */
export interface WebApi {
  search(
    query: string,
    o: { run_id: string | null; count: number; fresh?: "day" | "week" | "month" | "year" },
  ): Promise<LookOut<SearchResult[]>>;
  fetch(url: string, o: { run_id: string; start?: number; links?: boolean }): Promise<LookOut<Page>>;
}

/**
 * The browser as tools reach it. Opening and typing leave Atlas, so they
 * pass the outbox's checks with a receipt; while the owner has taken it
 * over, everything but `where` says so and waits.
 */
export interface BrowserApi {
  open(url: string, o: { run_id: string; start?: number }): Promise<BrowserPage>;
  look(o: { start?: number }): Promise<BrowserPage>;
  act(a: Exclude<BrowserAction, { act: "submit" }>, o: { run_id: string }): Promise<BrowserPage>;
  find(ref: string): Promise<PageElement | null>;
  takeOver(why: string): Promise<void>;
  close(): Promise<void>;
  where(): { open: boolean; url: string; title: string };
}

/** Connected MCP servers, as tools reach them (§9.2). */
export interface McpApi {
  servers(): McpServer[];
  /** Calls a tool that only reads, now, through the outbox; a tool with a page puts it on the stage. */
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    o: { run_id: string },
  ): Promise<{ ok: boolean; text: string; view?: StageView }>;
}

/** What a command in the workspace did. */
export interface RunResult {
  exit: number;
  /** What it printed (stdout and stderr together), at most 200 KB. */
  output: string;
  ms: number;
  /** Websites the workspace tried and wasn't allowed to reach. */
  blocked: string[];
  /** Said by the workspace along the way: setting up, starting, or why /workspace wasn't kept. */
  notes: string[];
}

/** The workspace (§9.1) as tools reach it. */
export interface WorkspaceApi {
  run(command: string, o: { run_id: string; timeout_s: number }): Promise<RunResult>;
  read(path: string): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }>;
  /** A link to a server on `port` in the workspace, for a day. */
  preview(port: number): Promise<{ url: string; expires: number }>;
  /** Websites the workspace may reach. */
  sites(): string[];
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
