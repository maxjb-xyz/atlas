// Brains are roles, not vendors (VISION §18). The loop speaks this one small
// shape; each provider adapter translates it to its own API.

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Invalid JSON arrives as `{ _raw: "..." }` and the tool rejects it. */
  input: unknown;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface BrainRequest {
  /** The stable, cacheable part of the prompt first, then the fresh part (§5.2). */
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Lower for voice: answer fast rather than think long. */
  effort?: "low" | "medium";
  maxOutputTokens?: number;
}

export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

export type BrainEvent =
  | { type: "text"; text: string }
  /** The model has started a tool call. Sent as early as the provider allows, for voice status lines. */
  | { type: "tool_start"; name: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; finish: "stop" | "tool_calls" | "length"; usage?: Usage };

export interface Brain {
  provider: "chatgpt" | "workers-ai" | "anthropic";
  model: string;
  stream(req: BrainRequest): AsyncIterable<BrainEvent>;
}

/** A provider failure with a plain reason, for health and fallback reports. */
export class BrainError extends Error {
  constructor(
    message: string,
    /** True when retrying on the same provider won't help (bad key, unknown model). */
    readonly permanent = false,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const brainKey = (b: { provider: string; model: string }) => `${b.provider}:${b.model}`;

/** Reads a server-sent-events body and yields each `data:` payload. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trimStart();
  } finally {
    // Stops the upstream request too when the consumer leaves early (an interrupt).
    reader.cancel().catch(() => {});
  }
}

export function parseArgs(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}
