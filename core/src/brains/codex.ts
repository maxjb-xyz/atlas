// Codex on the ChatGPT plan as a brain (§18). Atlas calls the model directly
// with the sign-in token, over the Responses API that the Codex CLI uses.
// Unlike old Atlas there's no local process or pipe: each step is one HTTPS
// request, so a dropped connection costs one request, not the brain.

import { type Brain, BrainError, type BrainEvent, type BrainRequest, type Message, parseArgs, sseData } from "./types";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface CodexAccess {
  /** A current token, refreshed if it's close to expiring. `force` refreshes now. Null when signed out. */
  access(force?: boolean): Promise<{ access_token: string; account_id: string | null } | null>;
}

type Item =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export function toInput(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    else if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.callId, output: m.content });
    else {
      if (m.content) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
      }
    }
  }
  return out;
}

interface Event {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string };
    incomplete_details?: { reason?: string };
  };
  message?: string;
  error?: { message?: string };
}

/** Turns a Responses API event stream into brain events. Exported for tests. */
export async function* readCodexStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<BrainEvent> {
  let sawTool = false;
  for await (const data of sseData(body, signal)) {
    if (data === "[DONE]") break;
    let e: Event;
    try {
      e = JSON.parse(data) as Event;
    } catch {
      continue;
    }
    switch (e.type) {
      case "response.output_text.delta":
        if (e.delta) yield { type: "text", text: e.delta };
        break;
      case "response.output_item.added":
        if (e.item?.type === "function_call" && e.item.name) yield { type: "tool_start", name: e.item.name };
        break;
      case "response.output_item.done":
        if (e.item?.type === "function_call") {
          sawTool = true;
          yield {
            type: "tool_call",
            call: { id: e.item.call_id ?? "", name: e.item.name ?? "", input: parseArgs(e.item.arguments ?? "") },
          };
        }
        break;
      case "response.completed":
      case "response.incomplete": {
        const u = e.response?.usage;
        yield {
          type: "done",
          finish: e.type === "response.incomplete" ? "length" : sawTool ? "tool_calls" : "stop",
          usage: u
            ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens }
            : undefined,
        };
        return;
      }
      case "response.failed":
        throw new BrainError(`ChatGPT: ${e.response?.error?.message ?? "the response failed"}`);
      case "error":
        throw new BrainError(`ChatGPT: ${e.message ?? e.error?.message ?? "stream error"}`);
    }
  }
  throw new BrainError("ChatGPT: the stream ended early");
}

export function codexBrain(auth: CodexAccess, model: string, f: typeof fetch = fetch): Brain {
  async function open(req: BrainRequest, force: boolean): Promise<Response> {
    const token = await auth.access(force);
    if (!token) throw new BrainError("ChatGPT isn't signed in", true);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
      originator: "atlas",
    };
    if (token.account_id) headers["chatgpt-account-id"] = token.account_id;
    return f(CODEX_URL, {
      method: "POST",
      headers,
      signal: req.signal,
      body: JSON.stringify({
        model,
        instructions: req.system,
        input: toInput(req.messages),
        tools: req.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false,
        })),
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: req.effort ?? "medium" },
        store: false,
        stream: true,
      }),
    });
  }

  return {
    provider: "codex",
    model,
    async *stream(req: BrainRequest): AsyncIterable<BrainEvent> {
      let res = await open(req, false);
      if (res.status === 401) res = await open(req, true);
      if (!res.ok || !res.body) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        if (res.status === 401 || res.status === 403)
          throw new BrainError("ChatGPT sign-in was refused. Sign in again in Settings.", true, res.status);
        if (res.status === 429) throw new BrainError("The ChatGPT plan's usage limit is reached for now.", false, 429);
        if (res.status === 400 || res.status === 404)
          throw new BrainError(`ChatGPT rejected the request: ${text || res.status}`, true, res.status);
        throw new BrainError(`ChatGPT: HTTP ${res.status} ${text}`, false, res.status);
      }
      yield* readCodexStream(res.body, req.signal);
    },
  };
}
