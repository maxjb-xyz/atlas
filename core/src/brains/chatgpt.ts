// ChatGPT on the owner's plan as a brain (§18), through OpenAI's official
// plan usage for open-source tools: the public Responses API at
// api.openai.com with the sign-in token. (chatgpt.com's own backend blocks
// requests from Cloudflare, and OpenAI asks tools not to use it.)
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

import { type Brain, BrainError, type BrainEvent, type BrainRequest, type Message, parseArgs, sseData } from "./types";

export const RESPONSES_URL = "https://api.openai.com/v1/responses";
/** Plan usage needs function tools grouped in a namespace. */
export const NAMESPACE = "atlas";

export interface ChatGPTAccess {
  /** A current token, refreshed if it's close to expiring. `force` refreshes now. Null when signed out. */
  access(force?: boolean): Promise<string | null>;
}

type Item =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; namespace: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export function toInput(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    else if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.callId, output: m.content });
    else {
      if (m.content) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, namespace: NAMESPACE, arguments: JSON.stringify(c.input ?? {}) });
      }
    }
  }
  return out;
}

/** The tool name without its namespace, however the server spells it. */
const bare = (name: string) => name.replace(new RegExp(`^${NAMESPACE}(\\.|__|/)`), "");

interface Event {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string; code?: string };
  };
  message?: string;
  code?: string;
  error?: { message?: string; code?: string };
}

/** Turns a Responses API event stream into brain events. Exported for tests. */
export async function* readResponsesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<BrainEvent> {
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
        if (e.item?.type === "function_call" && e.item.name) yield { type: "tool_start", name: bare(e.item.name) };
        break;
      case "response.output_item.done":
        if (e.item?.type === "function_call") {
          sawTool = true;
          yield {
            type: "tool_call",
            call: { id: e.item.call_id ?? "", name: bare(e.item.name ?? ""), input: parseArgs(e.item.arguments ?? "") },
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
        throw planError(e.response?.error?.code, e.response?.error?.message ?? "the response failed");
      case "error":
        throw planError(e.code ?? e.error?.code, e.message ?? e.error?.message ?? "stream error");
    }
  }
  throw new BrainError("ChatGPT: the answer ended early.");
}

/** OpenAI's documented plan-usage errors, in plain words, each with the right cooldown. */
function planError(code: string | undefined, message: string, status?: number): BrainError {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new BrainError(
        "Your ChatGPT plan's limit for Atlas is used up for now. ChatGPT settings → Usage shows when it resets.",
        false,
        429,
      );
    case "subscription_sharing_user_not_eligible":
      return new BrainError("This ChatGPT account can't share its plan with Atlas. Plan usage needs Plus or Pro.", true, 403);
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new BrainError("ChatGPT plan usage is unavailable right now. Atlas will try it again shortly.", false, 503);
    case "subscription_sharing_unsupported_capability":
      return new BrainError(`ChatGPT's plan route doesn't support part of this request: ${message}`, true, 400);
    case "subscription_sharing_invalid_user":
      return new BrainError("ChatGPT didn't accept the sign-in. If it keeps happening, sign in again in Settings → Brains.", true, 401);
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return new BrainError("Atlas isn't allowed to use your ChatGPT plan. Sign in again and allow plan usage.", true, 403);
  }
  return new BrainError(`ChatGPT: ${message}${code ? ` (${code})` : ""}`, false, status);
}

/** A plain reason for a refused request, with the status and what OpenAI said. Exported for tests. */
export async function refusal(res: Response): Promise<BrainError> {
  const raw = await res.text().catch(() => "");
  let code: string | undefined;
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { detail?: unknown; error?: { message?: unknown; code?: unknown }; message?: unknown };
    code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const d = body.error?.message ?? body.detail ?? body.message;
    if (d) detail = typeof d === "string" ? d : JSON.stringify(d);
  } catch {
    // Not JSON: an HTML page, so keep only its words.
    detail = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  if (code) return planError(code, detail, res.status);
  const status = `HTTP ${res.status}`;
  if (res.status === 401) return new BrainError(`ChatGPT refused the sign-in (${status}${detail ? `: ${detail}` : ""}).`, true, 401);
  if (res.status === 429) return new BrainError(`ChatGPT is rate limiting Atlas for now (${status}).`, false, 429);
  if (res.status === 400 || res.status === 403 || res.status === 404) {
    return new BrainError(`ChatGPT refused the request (${status}${detail ? `: ${detail}` : ""}).`, true, res.status);
  }
  return new BrainError(`ChatGPT: ${status}${detail ? ` ${detail}` : ""}`, false, res.status);
}

export function chatgptBrain(auth: ChatGPTAccess, model: string, f: typeof fetch = fetch): Brain {
  async function open(req: BrainRequest, force: boolean): Promise<Response> {
    const token = await auth.access(force);
    if (!token) throw new BrainError("ChatGPT isn't signed in.", true);
    return f(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": "Atlas (+https://github.com/maxjb-xyz/atlas)",
      },
      signal: req.signal,
      body: JSON.stringify({
        model,
        instructions: req.system,
        input: toInput(req.messages),
        ...(req.tools.length
          ? {
              tools: [
                {
                  type: "namespace",
                  name: NAMESPACE,
                  description: "Atlas's own tools.",
                  tools: req.tools.map((t) => ({
                    type: "function",
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                    strict: false,
                  })),
                },
              ],
              tool_choice: "auto",
              parallel_tool_calls: true,
            }
          : {}),
        reasoning: { effort: req.effort ?? "medium" },
        store: false,
        stream: true,
      }),
    });
  }

  return {
    provider: "chatgpt",
    model,
    async *stream(req: BrainRequest): AsyncIterable<BrainEvent> {
      let res = await open(req, false);
      if (res.status === 401) res = await open(req, true);
      if (!res.ok || !res.body) throw await refusal(res);
      yield* readResponsesStream(res.body, req.signal);
    },
  };
}
