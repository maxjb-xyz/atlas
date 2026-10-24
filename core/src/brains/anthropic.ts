// Anthropic by API key as a brain (§18): the Messages API, streamed, with
// tool use. The stable part of the prompt (the character, the portrait,
// standing instructions: everything before context.ts's separator) and the
// tools are marked for prompt caching, so a second turn reads them from the
// cache. Errors keep Anthropic's own words and the HTTP status.
// https://docs.anthropic.com/en/api/messages-streaming

import { type Brain, BrainError, type BrainEvent, type BrainRequest, type Message, parseArgs, sseData } from "./types";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const MODELS_URL = "https://api.anthropic.com/v1/models";
const VERSION = "2023-06-01";
/** Where context.ts joins the stable block and the fresh one (§5.2). */
const SPLIT = "\n\n---\n\n";
/** The answer's length when the request doesn't say: Messages needs one. */
const MAX_TOKENS = 8_192;

type Block =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Turn {
  role: "user" | "assistant";
  content: Block[];
}

/** The loop's messages as Messages turns: tool results ride in the next user turn, and turns of one role are merged. */
export function toTurns(messages: Message[]): Turn[] {
  const out: Turn[] = [];
  const push = (role: Turn["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content || "(empty)" }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.callId, content: m.content }]);
    else
      push("assistant", [
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input ?? {} })),
      ]);
  }
  // Messages starts with the user.
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** The system prompt in two blocks, the stable one cached (§5.2). */
export function toSystem(system: string): Block[] {
  const at = system.indexOf(SPLIT);
  if (at < 0) return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  return [
    { type: "text", text: system.slice(0, at), cache_control: { type: "ephemeral" } },
    { type: "text", text: system.slice(at + SPLIT.length) },
  ];
}

interface Event {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Turns a Messages event stream into brain events. Exported for tests. */
export async function* readMessagesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<BrainEvent> {
  const tools = new Map<number, { id: string; name: string; json: string }>();
  let input = 0;
  let cached = 0;
  let output = 0;
  let stop = "end_turn";
  for await (const data of sseData(body, signal)) {
    let e: Event;
    try {
      e = JSON.parse(data) as Event;
    } catch {
      continue;
    }
    switch (e.type) {
      case "message_start": {
        const u = e.message?.usage;
        cached = u?.cache_read_input_tokens ?? 0;
        input = (u?.input_tokens ?? 0) + cached + (u?.cache_creation_input_tokens ?? 0);
        break;
      }
      case "content_block_start":
        if (e.content_block?.type === "tool_use") {
          tools.set(e.index ?? 0, { id: e.content_block.id ?? "", name: e.content_block.name ?? "", json: "" });
          yield { type: "tool_start", name: e.content_block.name ?? "" };
        } else if (e.content_block?.type === "text" && e.content_block.text) yield { type: "text", text: e.content_block.text };
        break;
      case "content_block_delta":
        if (e.delta?.type === "text_delta" && e.delta.text) yield { type: "text", text: e.delta.text };
        else if (e.delta?.type === "input_json_delta") {
          const t = tools.get(e.index ?? 0);
          if (t) t.json += e.delta.partial_json ?? "";
        }
        break;
      case "content_block_stop": {
        const t = tools.get(e.index ?? 0);
        if (t) {
          tools.delete(e.index ?? 0);
          yield { type: "tool_call", call: { id: t.id, name: t.name, input: parseArgs(t.json) } };
        }
        break;
      }
      case "message_delta":
        if (e.delta?.stop_reason) stop = e.delta.stop_reason;
        if (e.usage?.output_tokens) output = e.usage.output_tokens;
        break;
      case "message_stop":
        yield {
          type: "done",
          finish: stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop",
          usage: { input, output, cached },
        };
        return;
      case "error":
        throw failure(undefined, e.error?.type, e.error?.message ?? "stream error");
    }
  }
  throw new BrainError("Anthropic: the answer ended early.");
}

/** Anthropic's error in plain words, with whether retrying can help and how long to wait. */
function failure(status: number | undefined, type: string | undefined, message: string): BrainError {
  const where = `Anthropic${status ? ` (HTTP ${status})` : ""}`;
  switch (type) {
    case "authentication_error":
      return new BrainError(`${where} refused the API key: ${message}. Check it in Settings → Brains.`, true, 401);
    case "permission_error":
      return new BrainError(`${where} says this key can't do that: ${message}`, true, 403);
    case "not_found_error":
      return new BrainError(`${where} doesn't know that model: ${message}`, true, 404);
    case "invalid_request_error":
      return new BrainError(`${where} refused the request: ${message}`, true, status ?? 400);
    case "rate_limit_error":
      return new BrainError(`${where} is rate limiting Atlas for now: ${message}`, false, 429);
    case "overloaded_error":
      return new BrainError(`${where} is overloaded right now: ${message}`, false, 529);
  }
  return new BrainError(`${where}: ${message}`, status === 400 || status === 401 || status === 403 || status === 404, status);
}

/** A refused request in Anthropic's own words. Exported for tests. */
export async function refusal(res: Response): Promise<BrainError> {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    if (body.error) return failure(res.status, body.error.type, body.error.message ?? raw.slice(0, 200));
  } catch {
    // Not JSON: keep the words.
  }
  return failure(res.status, undefined, raw.replace(/\s+/g, " ").trim().slice(0, 200) || "no answer");
}

const headers = (key: string) => ({ "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" });

export function anthropicBrain(key: () => string | null, model: string, f: typeof fetch = fetch): Brain {
  return {
    provider: "anthropic",
    model,
    async *stream(req: BrainRequest): AsyncIterable<BrainEvent> {
      const k = key();
      if (!k) throw new BrainError("Anthropic has no API key. Add one in Settings → Brains.", true);
      const tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        // The tools don't change between turns: the last one marks them all for the cache.
        ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      const res = await f(MESSAGES_URL, {
        method: "POST",
        headers: { ...headers(k), accept: "text/event-stream" },
        signal: req.signal,
        body: JSON.stringify({
          model,
          max_tokens: req.maxOutputTokens ?? MAX_TOKENS,
          system: toSystem(req.system),
          messages: toTurns(req.messages),
          ...(tools.length ? { tools } : {}),
          stream: true,
        }),
      });
      if (!res.ok || !res.body) throw await refusal(res);
      yield* readMessagesStream(res.body, req.signal);
    },
  };
}

/** Anthropic's live catalog (§11.4: newest by default, from the provider, not from code), newest first. */
export async function anthropicModels(key: string, f: typeof fetch = fetch): Promise<Array<{ id: string; name: string }>> {
  const res = await f(`${MODELS_URL}?limit=100`, { headers: headers(key) });
  if (!res.ok) throw await refusal(res);
  const body = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  return (body.data ?? []).filter((m) => m.id).map((m) => ({ id: m.id!, name: m.display_name ?? m.id! }));
}
