// ACP, the Agent Client Protocol (VISION §8.2): how Atlas drives a coding
// agent. It's an open standard, so its client is core; the agents (Codex,
// Claude Code) are extensions. Messages are JSON-RPC 2.0, one per line, over
// the agent's stdin and stdout, which reach the core through the workspace's
// bridge.
//
// This module is pure: it makes the lines to send and reads the lines that
// come back, and its state is plain JSON that a job keeps between wakes, so a
// restart of the agent object loses nothing. It speaks only what Atlas uses:
// starting or loading a session, a prompt and its updates, the agent's
// requests for permission, and cancel. Atlas offers the agent no file system
// or terminal of its own (the agent has the workspace), so those requests are
// answered "not supported".

import type { Json } from "./store/db";

export const PROTOCOL_VERSION = 1;

/** What the client keeps between lines. */
export interface AcpState {
  /** The next request id. */
  next: number;
  /** Requests sent and not yet answered, by id. */
  pending: Record<string, { method: string; at: number }>;
  /** The agent's session, once it has one. */
  session: string | null;
  /** The prompt in flight: its request id and when it was sent. */
  turn: { id: number; at: number } | null;
}

export const freshState = (): AcpState => ({ next: 1, pending: {}, session: null, turn: null });

/** One option the agent offers on a permission request. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** The agent asking before it does something. Its id is the JSON-RPC id to answer. */
export interface Ask {
  id: string | number;
  tool: {
    id: string;
    title: string;
    kind: string;
    input: Json;
    paths: string[];
  };
  options: PermissionOption[];
}

/** What a session update says, cut down to what Atlas keeps and shows. */
export type Update =
  | { kind: "message"; id: string | null; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; title: string | null; tool_kind: string | null; status: string | null; output: string; input: Json | null }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }
  | { kind: "usage"; used: number | null; size: number | null; cost: number | null }
  | { kind: "user"; text: string }
  | { kind: "other"; type: string };

export type AcpEvent =
  /** The answer to a request Atlas made. */
  | { type: "result"; id: number; method: string; result: Json }
  | { type: "error"; id: number; method: string; message: string; code: number | null }
  /** The prompt in flight ended. */
  | { type: "turn_end"; stop: string }
  | { type: "update"; update: Update }
  | { type: "ask"; ask: Ask }
  /** A line that wasn't JSON-RPC (the agent printed something else): kept, in its own words. */
  | { type: "noise"; text: string };

interface Read {
  state: AcpState;
  events: AcpEvent[];
  /** Lines to send back at once: "not supported" for what Atlas doesn't offer. */
  replies: string[];
}

const line = (m: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", ...m });

/** A request: the line to send, and the state with it pending. */
export function request(state: AcpState, method: string, params: Json): { state: AcpState; line: string; id: number } {
  const id = state.next;
  const next: AcpState = { ...state, next: id + 1, pending: { ...state.pending, [String(id)]: { method, at: Date.now() } } };
  if (method === "session/prompt") next.turn = { id, at: Date.now() };
  return { state: next, line: line({ id, method, params }), id };
}

/** A notification (no answer comes): cancel. */
export const notify = (method: string, params: Json): string => line({ method, params });

/** What Atlas tells the agent about itself: no file system or terminal of its own, and that it can route a model gateway. */
export const initializeParams = (version: string): Json => ({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { _meta: { gateway: true } } },
  clientInfo: { name: "atlas", title: "Atlas", version },
});

/** The answer to a permission request: an option the agent offered, or cancelled. */
export function answerAsk(ask: Ask, optionId: string | null): string {
  return line({
    id: ask.id,
    result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } },
  });
}

/** The option of a kind, when the agent offered one. */
export const optionOf = (ask: Ask, ...kinds: string[]): string | null => {
  for (const k of kinds) {
    const o = ask.options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return null;
};

const str = (v: unknown, n = 4_000): string => (typeof v === "string" ? v.slice(0, n) : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A value kept as it is when it's small, else as the start of its JSON, so a huge input can't fill a row. */
function small(v: unknown, n = 4_000): Json | null {
  if (v == null) return null;
  const s = JSON.stringify(v);
  return s.length <= n ? (v as Json) : { cut: s.slice(0, n) };
}

/** The text in an ACP content block, or a list of them. */
function textOf(c: unknown): string {
  if (Array.isArray(c)) return c.map(textOf).filter(Boolean).join("\n");
  const o = obj(c);
  if (o.type === "text") return str(o.text);
  if (o.type === "content") return textOf(o.content);
  if (o.type === "diff") return `${str(o.path, 300)} changed`;
  return "";
}

/** A session update as Atlas keeps it. */
export function readUpdate(u: Record<string, unknown>): Update {
  const type = str(u.sessionUpdate, 60);
  switch (type) {
    case "agent_message_chunk":
      return { kind: "message", id: str(u.messageId, 100) || null, text: textOf(u.content) };
    case "agent_thought_chunk":
      return { kind: "thought", text: textOf(u.content) };
    case "user_message_chunk":
      return { kind: "user", text: textOf(u.content) };
    case "tool_call":
    case "tool_call_update": {
      const meta = obj(u._meta);
      // Codex sends a command's output as it prints it; others put it in the content.
      const delta = str(obj(meta.terminal_output_delta).data, 8_000);
      return {
        kind: "tool",
        id: str(u.toolCallId, 200),
        title: str(u.title, 300) || null,
        tool_kind: str(u.kind, 40) || null,
        status: str(u.status, 40) || null,
        output: delta || textOf(u.content),
        input: small(u.rawInput),
      };
    }
    case "plan":
      return {
        kind: "plan",
        entries: (Array.isArray(u.entries) ? u.entries : [])
          .slice(0, 30)
          .map((e) => ({ content: str(obj(e).content, 300), status: str(obj(e).status, 30) })),
      };
    case "usage_update": {
      const cost = obj(u.cost);
      return {
        kind: "usage",
        used: typeof u.used === "number" ? u.used : null,
        size: typeof u.size === "number" ? u.size : null,
        cost: typeof cost.amount === "number" ? cost.amount : null,
      };
    }
    default:
      return { kind: "other", type };
  }
}

/** Reads one line from the agent. */
export function read(state: AcpState, text: string): Read {
  const t = text.trim();
  if (!t) return { state, events: [], replies: [] };
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return { state, events: [{ type: "noise", text: t.slice(0, 2_000) }], replies: [] };
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { state, events: [{ type: "noise", text: t.slice(0, 2_000) }], replies: [] };
  const hasId = m.id !== undefined && m.id !== null;

  // An answer to one of Atlas's requests.
  if (hasId && !m.method && ("result" in m || "error" in m)) {
    const key = String(m.id);
    const sent = state.pending[key];
    const { [key]: _done, ...rest } = state.pending;
    const next: AcpState = { ...state, pending: rest };
    const method = sent?.method ?? "unknown";
    const events: AcpEvent[] = [];
    if ("error" in m && m.error) {
      const e = obj(m.error);
      const data = e.data == null ? "" : ` (${JSON.stringify(e.data).slice(0, 500)})`;
      events.push({
        type: "error",
        id: Number(m.id),
        method,
        message: `${str(e.message, 1_000) || "The agent refused."}${data}`,
        code: typeof e.code === "number" ? e.code : null,
      });
    } else {
      events.push({ type: "result", id: Number(m.id), method, result: (m.result ?? null) as Json });
    }
    if (state.turn && String(state.turn.id) === key) {
      next.turn = null;
      const stop = "error" in m && m.error ? "error" : str(obj(m.result).stopReason, 40) || "end_turn";
      events.push({ type: "turn_end", stop });
    }
    if (method === "session/new" && !("error" in m && m.error)) next.session = str(obj(m.result).sessionId, 200) || next.session;
    return { state: next, events, replies: [] };
  }

  const method = str(m.method, 100);
  const params = obj(m.params);
  if (method === "session/update") return { state, events: [{ type: "update", update: readUpdate(obj(params.update)) }], replies: [] };
  if (method === "session/request_permission" && hasId) {
    const tc = obj(params.toolCall);
    const ask: Ask = {
      id: m.id as string | number,
      tool: {
        id: str(tc.toolCallId, 200),
        title: str(tc.title, 300),
        kind: str(tc.kind, 40),
        input: small(tc.rawInput),
        paths: (Array.isArray(tc.locations) ? tc.locations : [])
          .map((l) => str(obj(l).path, 500))
          .filter(Boolean)
          .slice(0, 20),
      },
      options: (Array.isArray(params.options) ? params.options : []).map((o) => ({
        optionId: str(obj(o).optionId, 100),
        name: str(obj(o).name, 100),
        kind: str(obj(o).kind, 40),
      })),
    };
    return { state, events: [{ type: "ask", ask }], replies: [] };
  }
  // Anything else the agent asks of the client (files, terminals, sign-in prompts) Atlas doesn't offer.
  if (hasId && method) {
    return {
      state,
      events: [],
      replies: [
        line({ id: m.id, error: { code: -32601, message: `Atlas doesn't offer ${method}: use the workspace's shell and files.` } }),
      ],
    };
  }
  // Other notifications (auth status, extensions) change nothing Atlas keeps.
  return { state, events: [], replies: [] };
}
