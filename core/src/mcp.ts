// MCP (§9.2, §21.6): servers the owner connects, so Atlas can grow its own
// abilities. The Agents SDK's MCP client does the connecting, the sign-in
// (OAuth) and keeping connections across sleeps; this file is Atlas's side:
// which tools the model may use, what a result says in words, and the MCP
// Apps a tool can bring (a page of its own, shown on the stage).

import { getState, setState } from "./store/state";
import type { Sql } from "./store/db";

/** A tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>;
}

/** A connected server, as Atlas and the app see it. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  /** authenticating (waiting for the owner to sign in), connecting, connected, discovering, ready, failed. */
  state: string;
  /** Where the owner signs in, while it's authenticating. */
  auth_url: string | null;
  error: string | null;
  /** What the server says about itself, for the model. */
  instructions: string | null;
  tools: McpTool[];
}

/** What a tool call answers (MCP's CallToolResult). */
export interface McpResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpResource {
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }>;
}

/** The MCP client, as Atlas uses it: the Agents SDK's, or a fake in tests. */
export interface McpClient {
  servers(): McpServer[];
  /** Connects a server. An OAuth server answers `authenticating` with where the owner signs in. */
  add(o: { name: string; url: string; token?: string }): Promise<{ id: string; state: string; auth_url?: string }>;
  remove(id: string): Promise<void>;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpResult>;
  read(server: string, uri: string): Promise<McpResource>;
  /** Waits, at most `ms`, for connections still starting (after a sleep). */
  settle(ms: number): Promise<void>;
}

/** MCP Apps' content type for a tool's page. */
export const APP_MIME = "text/html;profile=mcp-app";

/** What Atlas tells a server it can show: MCP Apps. */
export const UI_EXTENSION = { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] } };

/** A tool's page, if it brings one, and who may use the tool: the model, the page, or both. */
export function uiOf(t: McpTool): { uri: string; visibility: Array<"model" | "app"> } | null {
  const ui = (t._meta?.ui ?? {}) as { resourceUri?: unknown; visibility?: unknown };
  const uri =
    typeof ui.resourceUri === "string"
      ? ui.resourceUri
      : typeof t._meta?.["ui/resourceUri"] === "string"
        ? String(t._meta["ui/resourceUri"])
        : null;
  const visibility = Array.isArray(ui.visibility)
    ? (ui.visibility.filter((v) => v === "model" || v === "app") as Array<"model" | "app">)
    : ["model" as const, "app" as const];
  const page = uri?.startsWith("ui://") ? uri : "";
  return page || visibility.length < 2 ? { uri: page, visibility } : null;
}

/** Tools only a page may call are hidden from the model (MCP Apps: visibility). */
export const forModel = (t: McpTool) => uiOf(t)?.visibility.includes("model") ?? true;
export const forApp = (t: McpTool) => uiOf(t)?.visibility.includes("app") ?? true;

/** A tool that only reads (its server says so) is a look; anything else reaches outside (§12.1). */
export const readOnly = (t: McpTool) => t.annotations?.readOnlyHint === true;

/** Finds a ready server by its id or name. */
export function findServer(servers: McpServer[], nameOrId: string): McpServer | null {
  const n = nameOrId.trim().toLowerCase();
  return servers.find((s) => s.id === nameOrId) ?? servers.find((s) => s.name.toLowerCase() === n) ?? null;
}

/** The most of a result the model reads at once. */
const MAX_TEXT = 16_000;

/** A tool's answer in words for the model: its text, its structured data, and what else it sent. */
export function resultText(r: McpResult): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "resource_link") parts.push(`[link: ${String(c.name ?? c.uri)} ${String(c.uri ?? "")}]`);
    else if (c.type === "resource") {
      const res = (c.resource ?? {}) as { uri?: string; text?: string };
      parts.push(res.text ? res.text : `[resource: ${res.uri ?? "?"}]`);
    } else parts.push(`[${String(c.type)}${c.mimeType ? `, ${String(c.mimeType)}` : ""}]`);
  }
  if (r.structuredContent !== undefined && !parts.some((p) => p.trim().startsWith("{") || p.trim().startsWith("["))) {
    parts.push(JSON.stringify(r.structuredContent));
  }
  const text = parts.join("\n").trim() || "(it answered with nothing)";
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (cut at ${MAX_TEXT} characters)` : text;
}

/** The line in every run's context about connected servers (§9.2): what each is for, so Atlas knows to look. */
export function serversLine(servers: McpServer[]): string | null {
  if (!servers.length) return null;
  const lines = servers.map((s) => {
    const n = s.tools.filter(forModel).length;
    const about = (s.instructions ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const state =
      s.state === "ready" ? `${n} tool${n === 1 ? "" : "s"}` : s.state === "authenticating" ? "waiting for the owner to sign in" : s.state;
    return `- ${s.name} (${state})${about ? `: ${about}` : ""}`;
  });
  return `Connected servers (MCP). Find their tools with mcp_tools, use one with mcp_call:\n${lines.join("\n")}`;
}

// --- MCP Apps ---------------------------------------------------------------------------------

/** One tool call whose page is on the stage: enough to show it again. */
export interface McpAppCall {
  id: string;
  server: string;
  tool: string;
  uri: string;
  input: Record<string, unknown>;
  result: McpResult;
  at: number;
}

/** How many calls' pages are kept to show again. */
const KEEP_APPS = 20;

export function keepApp(sql: Sql, call: McpAppCall): void {
  const all = getState<McpAppCall[]>(sql, "mcp_apps") ?? [];
  // A result too big to keep is cut to its words; the page still gets its input.
  const result =
    JSON.stringify(call.result).length > 200_000 ? { content: [{ type: "text", text: resultText(call.result) }] } : call.result;
  setState(sql, "mcp_apps", [{ ...call, result }, ...all.filter((a) => a.id !== call.id)].slice(0, KEEP_APPS));
}

export const getApp = (sql: Sql, id: string): McpAppCall | null =>
  (getState<McpAppCall[]>(sql, "mcp_apps") ?? []).find((a) => a.id === id) ?? null;

/** A domain a page declares, if it's one CSP can take as-is (no spaces, quotes or semicolons). */
const cspSource = (d: unknown): string | null =>
  typeof d === "string" && /^(https?:\/\/|wss?:\/\/)?(\*\.)?[a-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/i.test(d) ? d : null;

/**
 * The Content-Security-Policy for an app's page (MCP Apps): nothing outside
 * the page unless its resource declared the domain. The default is the
 * spec's: inline scripts and styles, data: images, no network.
 */
export function appCsp(meta: Record<string, unknown> | undefined): string {
  const csp = ((meta?.ui as { csp?: Record<string, unknown> } | undefined)?.csp ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(csp[k]) ? (csp[k] as unknown[]).map(cspSource).filter((d): d is string => d != null) : []);
  const res = list("resourceDomains").join(" ");
  const connect = list("connectDomains").join(" ");
  const frame = list("frameDomains").join(" ");
  const base = list("baseUriDomains").join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`.trim(),
    `style-src 'unsafe-inline' ${res}`.trim(),
    `img-src data: blob: ${res}`.trim(),
    `font-src data: ${res}`.trim(),
    `media-src data: blob: ${res}`.trim(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frame || "'none'"}`,
    `base-uri ${base || "'none'"}`,
  ].join("; ");
}
