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
import type { Found, Point, Route, Travel } from "../maps";
import type { Weather } from "../weather";

/** What kind of action a tool takes decides when Atlas asks first (§12.1). */
export type { ToolKind } from "../approvals";

/** A face's run (§7.2): which face, the conversation, and how it reaches the owner. */
export interface FaceRun {
  face: import("../faces").Face;
  conv: string;
  /** Who's writing, as they gave themselves ("Jordan <jordan@x.com>", "@jordan"), and the person Atlas knows them as. */
  from: string;
  person: string | null;
  /** Hands something to the owner: a message, or a pull-in that may push now. */
  pull(o: { kind: "message" | "handoff"; text: string; urgent: boolean; details?: Record<string, string> }): Promise<void>;
}

export interface ToolContext {
  sql: Sql;
  /** Set only in a face's run: the face and its conversation. */
  face?: FaceRun;
  /** The areas shared between the owner and members (§7.1), kept in the owner's Atlas. */
  shared?: {
    list(): Promise<import("../protocol").SharedArea[]>;
    save(o: { area: string; name: string; fact: string; type: string }): Promise<{ ok: boolean; text: string }>;
  } | null;
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
  /** Coding jobs (§8.2): start one, pass the owner's words to one, see how they're doing. Absent where jobs can't be reached. */
  coding?: CodingApi | null;
  /** Jobs Atlas owns (§8.3): owner runs start one. */
  goals?: GoalsApi | null;
  /**
   * Changing Atlas's own settings (§21), only in a run the owner started: the change, through the same path as the
   * app's, and whether this run has read the web (§20), which keeps it from loosening the owner's rules.
   */
  settingsEdit?: {
    change(patch: import("../store/settings").SettingsPatch): { ok: boolean; text: string };
    readWeb(): boolean;
  } | null;
  /** A job's turn (§8.3): its moves, bound to that job. Null elsewhere. */
  ownedJob?: OwnedJobApi | null;
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
  /** Maps and weather (§19.1), through the outbox's checks; absent or null where they can't be reached. */
  maps?: MapsApi | null;
  /** Paired devices (§16.3), through the outbox; absent or null where they can't be reached. */
  devices?: DevicesApi | null;
  /** Automations, for owner runs; null elsewhere. */
  automations: AutomationsApi | null;
  /** Extensions (§17): keeps one Atlas wrote as a draft, for the owner to install. Owner runs only. */
  extensions?: { draft(code: string): Promise<{ id: string; name: string; hosts: string[] }> } | null;
  /**
   * Skill hubs (§17): finding a skill to install, and installing one. Only a run the owner started, in the
   * owner's own Atlas; `readWeb` says the run has read the web, which could be steering it.
   */
  hubs?: {
    find(query: string): ReturnType<import("../agent/hubs").HubDesk["find"]>;
    install(hub: string, name: string, o: { run_id: string }): ReturnType<import("../agent/hubs").HubDesk["install"]>;
    readWeb(): boolean;
  } | null;
  /** Speaking up changed (`speaking_up`): the moments are put on the clock again. */
  speaking?: () => Promise<void>;
  /**
   * Runs an extension's tool (§17) through the outbox, for a look or a change Undo takes back; anything that
   * asks goes through `exit`. Absent where extensions' tools can't be used.
   */
  extTool?:
    | ((
        c: { ext: string; tool: string; name: string; input: Record<string, unknown>; undo?: string },
        o: { run_id: string },
      ) => Promise<{ ok: boolean; text: string; link?: string; undo?: import("../store/log").Undo }>)
    | null;
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

/**
 * Maps and weather, as tools reach them. Each call leaves Atlas, so it
 * passes the outbox's checks and leaves a receipt; `label` is what the
 * receipt says it was about, in words ("Gym to Home"), not coordinates.
 */
export interface MapsApi {
  provider(): import("../maps").MapsProvider;
  geocode(q: string, o: { run_id: string | null; near?: Point }): Promise<LookOut<Found[]>>;
  reverse(p: Point, o: { run_id: string | null }): Promise<LookOut<Found>>;
  route(via: Point[], travel: Travel, o: { run_id: string | null; label: string }): Promise<LookOut<Route>>;
  nearby(
    q: { kind?: string; name?: string; near: Point; along?: Array<[number, number]>; within: number; limit: number },
    o: { run_id: string | null; label: string },
  ): Promise<LookOut<Found[]>>;
  /** The forecast for a rough area around a point (rounded here, so a caller can't send more). */
  weather(p: Point, o: { run_id: string | null; label: string }): Promise<LookOut<Weather>>;
}

/** Paired devices, as tools reach them: a call now when the device is online, else when it's back. */
export interface DevicesApi {
  call(
    c: { node: string; device: string; tool: string; input: Record<string, import("../store/db").Json> },
    o: { run_id: string | null; by: string },
  ): Promise<{ ok: boolean; text: string; queued?: boolean }>;
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
  /** `cwd` is /workspace by default, or a coding job's folder; `rules` are keys for this command only (a git token behind a nonce). */
  run(
    command: string,
    o: {
      run_id: string;
      timeout_s: number;
      cwd?: string;
      rules?: import("../workspace").KeyRule[];
      env?: Record<string, string>;
      as?: string;
    },
  ): Promise<RunResult>;
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
  start(o: {
    title: string;
    brief: string;
    tools: string[];
    asked_in: string;
    research?: boolean;
    brain?: string;
  }): Promise<{ id: string }>;
  /** The job's result, or null if it's still running after `ms` (it's then reported when it ends). */
  wait(id: string, ms: number): Promise<{ state: "done" | "failed" | "cancelled"; text: string; error?: string } | null>;
}

/** What the owner's runs can do with coding jobs (§8.2). */
export interface CodingApi {
  repos(): Promise<Array<{ repo: string; about?: string; default_branch: string; pushed_at?: string }>>;
  /** Starts a job; throws, with the reason, when it can't (no coding agent set up, no code host, a repo it can't see). */
  start(o: {
    title: string;
    repo: string;
    task: string;
    agent?: string;
    base?: string;
    asked_in: string;
  }): Promise<{ id: string; agent: string; branch: string }>;
  /** The owner's words for a job: an answer to its question, or a change of direction while it works. */
  answer(id: string, text: string): Promise<{ ok: boolean; text: string }>;
  look(id?: string): unknown[];
}

/** What the owner's runs can do with jobs Atlas owns (§8.3). */
export interface GoalsApi {
  start(o: {
    title: string;
    goal: string;
    brain?: string;
    deadline?: number;
    asked_in: string;
    asked_by: string | null;
  }): Promise<{ id: string; folder: string }>;
}

type Done = Promise<{ ok: boolean; text: string }>;

/** A job's turn (§8.3): its moves, bound to the job it's working on. */
export interface OwnedJobApi {
  id: string;
  notes(text: string): { ok: boolean; text: string };
  update(o: { text: string; files?: Array<{ path: string; name?: string }> }): Done;
  ask(o: { text: string; options?: string[]; content?: string; files?: Array<{ path: string; name?: string }> }): Done;
  build(o: { brief: string; agent?: string; model?: string; effort?: string; minutes?: number }): Done;
  helpers(o: { tasks: Array<{ title: string; brief: string }>; research?: boolean }): Done;
  wait(o: { minutes: number; why: string }): Done;
  site(o: { host: string; why: string }): Done;
  deadline(at: number | null): { ok: boolean; text: string };
  finish(o: { summary: string; files?: Array<{ path: string; name?: string; note?: string }> }): Done;
  fail(why: string): Done;
  /** One of the owner's files, back into the job's folder. */
  bring(o: { file: string; path?: string }): Done;
  /** Stops the work the job handed off, at once. */
  stopWork(why: string): Done;
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
  /** Its input as brains see it, when it's given as a JSON Schema rather than made from `input` (an extension's tool, §17). */
  schema?: Record<string, unknown>;
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
  /** Said or shown while it runs, when Atlas hasn't said anything yet: every tool has one, so voice is never quiet while it works. */
  status: string;
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
  if (tool.schema)
    return { name: tool.name, description: tool.description, parameters: withoutPropertyNames(tool.schema) as Record<string, unknown> };
  const schema = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: withoutPropertyNames(schema) as Record<string, unknown> };
}

/**
 * A schema every provider takes: no `propertyNames`, and no tuples. Draft 7 writes a tuple as `items: [a, b]`,
 * which Workers AI's models refuse for the whole tool list ("is not of type 'object', 'boolean'"); it becomes a
 * list of the first item's kind with a fixed length.
 */
function withoutPropertyNames(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutPropertyNames);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "propertyNames") continue;
    if (k === "items" && Array.isArray(x)) {
      out.items = withoutPropertyNames(x[0] ?? {});
      out.minItems = x.length;
      out.maxItems = x.length;
      continue;
    }
    if (k === "additionalItems") continue;
    out[k] = withoutPropertyNames(x);
  }
  return out;
}

/** Plain-words failure the model can act on. */
export const fail = (message: string): ToolResult => ({ ok: false, output: { error: message } });
