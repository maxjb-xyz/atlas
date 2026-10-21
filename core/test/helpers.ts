import { env as testEnv } from "cloudflare:test";
import type { Brain, BrainEvent, BrainRequest } from "../src/brains/types";
import { BrainError } from "../src/brains/types";
import type { CalendarEvent, CalendarSource } from "../src/calendar/types";

export const env = testEnv as unknown as Env;
export const SECRET = "test-owner-secret-not-real";

/** One scripted model call: events to stream, a function of the request, or an error to throw. */
export type Step = BrainEvent[] | ((req: BrainRequest) => BrainEvent[]) | Error;

/**
 * A brain that plays a script, one entry per call, and records every
 * request it got. Shared across brains made from the same script.
 */
export function scripted(steps: Step[], provider: Brain["provider"] = "workers-ai", model = "fake") {
  const requests: BrainRequest[] = [];
  const brain: Brain = {
    provider,
    model,
    async *stream(req) {
      requests.push(req);
      const step = steps.shift();
      if (!step) throw new BrainError("script ran out");
      if (step instanceof Error) throw step;
      const events = typeof step === "function" ? step(req) : step;
      for (const e of events) {
        if (req.signal?.aborted) return;
        yield e;
        await Promise.resolve();
      }
    },
  };
  return { brain, requests, steps };
}

export const say = (text: string): BrainEvent[] => [
  { type: "text", text },
  { type: "done", finish: "stop" },
];

export const call = (name: string, input: unknown, id = `call_${name}`): BrainEvent[] => [
  { type: "tool_start", name },
  { type: "tool_call", call: { id, name, input } },
  { type: "done", finish: "tool_calls" },
];

export function fakeCalendar(events: CalendarEvent[]): CalendarSource & { ranges: Array<{ start: Date; end: Date }> } {
  const ranges: Array<{ start: Date; end: Date }> = [];
  return {
    ranges,
    async list(range) {
      ranges.push(range);
      return events.filter((e) => new Date(e.end) > range.start && new Date(e.start) < range.end);
    },
    async check() {
      return { calendars: ["Home", "Work"], events_next_30_days: events.length };
    },
  };
}

/** A body that streams the given server-sent-event payloads. */
export function sse(payloads: Array<string | object>, split = 7): ReadableStream<Uint8Array> {
  const text = payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + split));
      i += split;
    },
  });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
