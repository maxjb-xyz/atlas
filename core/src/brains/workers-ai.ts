// Workers AI as a brain (§18): comes with the Cloudflare account, runs on the
// same network as the agent, and needs no key. Models take OpenAI-style chat
// messages and tools; streams come back as server-sent events in either the
// OpenAI chunk shape or the older `{ response }` shape, so both are read.
//
// With an AI Gateway set, calls go through it by the binding's own `gateway`
// option (`{ id }`, per workers-types' AiOptions and Cloudflare's Workers AI
// binding page, read 2026-10-25), so they show in the gateway's logs. The free
// allowance (10,000 neurons a day) resets at 00:00 UTC; on the free plan,
// running past it fails until then, which is a brain running out.
// https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/

import { nextDayUtc } from "./catalog";
import { type Brain, BrainError, type BrainEvent, type BrainRequest, type Message, parseArgs, sseData, type ToolSpec } from "./types";

interface AiLike {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.callId, name: m.name, content: m.content });
    else {
      const msg: ChatMessage = { role: "assistant", content: m.content };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(msg);
    }
  }
  return out;
}

const toTools = (tools: ToolSpec[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

interface Chunk {
  response?: string;
  tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** Turns a Workers AI event stream into brain events. Exported for tests. */
export async function* readWorkersAIStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<BrainEvent> {
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let finish: "stop" | "tool_calls" | "length" = "stop";
  let usage: { input: number; output: number; cached?: number } | undefined;
  let seq = 0;

  for await (const data of sseData(body, signal)) {
    if (data === "[DONE]") break;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      continue;
    }
    if (chunk.usage) {
      usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        cached: chunk.usage.prompt_tokens_details?.cached_tokens,
      };
    }
    // Older shape: { response: "text", tool_calls: [{ name, arguments }] }.
    if (typeof chunk.response === "string" && chunk.response) yield { type: "text", text: chunk.response };
    for (const tc of chunk.tool_calls ?? []) {
      const name = tc.name ?? tc.function?.name ?? "";
      const raw = tc.arguments ?? tc.function?.arguments ?? {};
      const input = typeof raw === "string" ? parseArgs(raw) : raw;
      yield { type: "tool_start", name };
      yield { type: "tool_call", call: { id: tc.id ?? `call_${++seq}`, name, input } };
      finish = "tool_calls";
    }
    // OpenAI shape: choices[0].delta with content and tool call fragments by index.
    const choice = chunk.choices?.[0];
    if (choice) {
      const text = choice.delta?.content;
      if (text) yield { type: "text", text };
      for (const frag of choice.delta?.tool_calls ?? []) {
        const index = frag.index ?? 0;
        let call = pending.get(index);
        if (!call) {
          call = { id: frag.id ?? `call_${++seq}`, name: "", args: "" };
          pending.set(index, call);
        }
        if (frag.id) call.id = frag.id;
        if (frag.function?.name) {
          const first = !call.name;
          call.name += frag.function.name;
          if (first) yield { type: "tool_start", name: call.name };
        }
        if (frag.function?.arguments) call.args += frag.function.arguments;
      }
      if (choice.finish_reason === "length") finish = "length";
    }
  }
  for (const call of pending.values()) {
    yield { type: "tool_call", call: { id: call.id, name: call.name, input: parseArgs(call.args) } };
    finish = "tool_calls";
  }
  yield { type: "done", finish, usage };
}

/** Workers AI's failure in its own words, with whether it's the free allowance, a paid model or the request. Exported for tests. */
export function workersAIError(model: string, message: string, now = Date.now()): BrainError {
  if (/daily free allocation|neurons? (?:per day|a day|limit)|4006/i.test(message)) {
    return new BrainError(`Workers AI: ${message} The free allowance starts again at 00:00 UTC.`, false, 429, nextDayUtc(now));
  }
  // Some models need the Workers Paid plan; that won't change by retrying, so say what to do.
  const paid = /paid|billing|upgrade/i.test(message);
  const permanent = paid || /no such model|not found|invalid|unsupported|bad input/i.test(message);
  const hint = paid ? ` ${model} may need the Workers Paid plan; on the free plan, @cf/moonshotai/kimi-k2.5 works.` : "";
  return new BrainError(`Workers AI: ${message}${hint}`, permanent);
}

/** Workers AI as a brain; `gateway` names the owner's AI Gateway to go through, when they set one. */
export function workersAIBrain(ai: AiLike, model: string, gateway: () => string | null = () => null): Brain {
  return {
    provider: "workers-ai",
    model,
    async *stream(req: BrainRequest): AsyncIterable<BrainEvent> {
      const inputs: Record<string, unknown> = {
        messages: toChatMessages(req.system, req.messages),
        stream: true,
        max_tokens: req.maxOutputTokens ?? 4096,
      };
      if (req.tools.length) inputs.tools = toTools(req.tools);
      let result: unknown;
      const id = gateway();
      try {
        result = await ai.run(model, inputs, { signal: req.signal, ...(id ? { gateway: { id } } : {}) });
      } catch (err) {
        const e = workersAIError(model, err instanceof Error ? err.message : String(err));
        throw id ? new BrainError(`${e.message} (through AI Gateway "${id}")`, e.permanent, e.status, e.resetAt) : e;
      }
      if (!(result instanceof ReadableStream)) {
        // A model that ignored `stream`: one complete answer, in either shape.
        const raw = (result ?? {}) as Chunk & { choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }> };
        const message = raw.choices?.[0]?.message;
        const r: Chunk = message
          ? {
              usage: raw.usage,
              choices: [
                {
                  delta: {
                    content: message.content ?? null,
                    tool_calls: (message.tool_calls ?? []).map((tc, index) => ({ ...(tc as object), index })),
                  },
                },
              ],
            }
          : raw;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(r)}\n\n`));
            c.close();
          },
        });
        yield* readWorkersAIStream(body, req.signal);
        return;
      }
      yield* readWorkersAIStream(result as ReadableStream<Uint8Array>, req.signal);
    },
  };
}
