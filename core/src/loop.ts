// One loop (§4.1). Every run, whatever started it, is this: the model
// streams, calls tools, sees their results, and goes again until it answers
// or the budget runs out. Nothing here rewrites what the model says (rule 1).

import { BrainError, type BrainEvent, brainKey, type Message, type ToolCall, type Usage } from "./brains/types";
import type { BrainRouter } from "./brains/router";
import type { Sql } from "./store/db";
import { append, type LogRow, type Surface } from "./store/log";
import type { FinalState } from "./store/runs";
import type { BrainChoice } from "./store/settings";
import { type Tool, type ToolContext, type ToolResult, fail, toSpec } from "./tools/types";

export interface Budget {
  /** Model calls with tools. One more call without tools always follows when it runs out. */
  steps: number;
  /** Soft time limit: once passed, the next call is the final one. */
  ms: number;
}

/** Starting points from §4.1. */
export const BUDGETS = {
  chat: { steps: 40, ms: 5 * 60_000 },
  voice: { steps: 12, ms: 90_000 },
  background: { steps: 150, ms: 15 * 60_000 },
} satisfies Record<string, Budget>;

export const BUDGET_NOTE =
  "You've used this run's step budget. Answer now from what you've found, without tools: say what you found, and ask whether to keep going.";

export interface RunSpec {
  runId: string;
  role: "main" | "voice";
  surface: Surface;
  system: string;
  messages: Message[];
  tools: Tool[];
  budget: Budget;
  signal?: AbortSignal;
  /** Put between text from separate steps: a space when spoken, a paragraph break in text. */
  joiner: string;
  effort?: "low" | "medium";
  /** How long a brain gets to start answering before the next one is tried. */
  firstEventMs: number;
}

export interface LoopDeps {
  sql: Sql;
  router: BrainRouter;
  chain: BrainChoice[];
  toolContext: Omit<ToolContext, "run_id">;
}

export type LoopEvent =
  | { type: "text"; text: string }
  /** `speakable` is true when Atlas hasn't said anything yet in this step, so voice can say it. */
  | { type: "status"; text: string | null; speakable: boolean }
  | { type: "row"; row: LogRow }
  /** Tools finished running; whatever Atlas says next comes from their results. */
  | { type: "tools"; names: string[] };

export interface LoopResult {
  state: FinalState;
  text: string;
  steps: number;
  brain: { provider: string; model: string } | null;
  fallback: boolean;
  interrupted: boolean;
  usage: Usage;
  error?: string;
}

class NoBrainError extends Error {}

const MAX_TOOL_OUTPUT = 16_000;

export async function runLoop(deps: LoopDeps, spec: RunSpec, emit: (e: LoopEvent) => void): Promise<LoopResult> {
  const started = Date.now();
  const messages: Message[] = [...spec.messages];
  const usage: Usage = { input: 0, output: 0, cached: 0 };
  let text = "";
  let steps = 0;
  let lastBrain: LoopResult["brain"] = null;
  let fellBack = false;

  const say = (t: string) => {
    if (!t) return;
    text += t;
    emit({ type: "text", text: t });
  };

  const result = (state: FinalState, extra: Partial<LoopResult> = {}): LoopResult => ({
    state,
    text: text.trimEnd(),
    steps,
    brain: lastBrain,
    fallback: fellBack,
    interrupted: false,
    usage,
    ...extra,
  });

  try {
    while (true) {
      const over = steps >= spec.budget.steps || Date.now() - started > spec.budget.ms;
      steps += 1;
      const step = await runStep(deps, spec, {
        system: over ? `${spec.system}\n\n${BUDGET_NOTE}` : spec.system,
        messages,
        tools: over ? [] : spec.tools,
        say,
        emit,
        alreadySaid: () => text.length > 0,
      });
      if (spec.signal?.aborted) throw new Error("interrupted");
      lastBrain = step.brain;
      fellBack ||= step.fellBack;
      usage.input += step.usage?.input ?? 0;
      usage.output += step.usage?.output ?? 0;
      usage.cached = (usage.cached ?? 0) + (step.usage?.cached ?? 0);

      if (over || step.calls.length === 0) break;

      // Close what Atlas just said before the tools run, so voice speaks it now:
      // a sentence only counts as finished once the space after it arrives.
      if (text && !text.endsWith(spec.joiner)) {
        text += spec.joiner;
        emit({ type: "text", text: spec.joiner });
      }
      messages.push({ role: "assistant", content: step.text, toolCalls: step.calls });
      const outputs = await Promise.all(step.calls.map((call) => runTool(deps, spec, call, emit)));
      for (const [i, call] of step.calls.entries()) {
        messages.push({ role: "tool", callId: call.id, name: call.name, content: outputs[i]! });
      }
      emit({ type: "status", text: null, speakable: false });
      emit({ type: "tools", names: step.calls.map((c) => c.name) });
    }
  } catch (err) {
    emit({ type: "status", text: null, speakable: false });
    if (spec.signal?.aborted) {
      return text
        ? result("replied", { interrupted: true })
        : result("failed", { interrupted: true, error: "Interrupted before answering." });
    }
    const message = err instanceof Error ? err.message : String(err);
    return result("failed", { error: message });
  }

  emit({ type: "status", text: null, speakable: false });
  if (!text.trim()) return result("failed", { error: "The brain gave an empty answer." });
  return result("replied");
}

interface StepIo {
  system: string;
  messages: Message[];
  tools: Tool[];
  say: (t: string) => void;
  emit: (e: LoopEvent) => void;
  alreadySaid: () => boolean;
}

interface StepResult {
  text: string;
  calls: ToolCall[];
  brain: { provider: string; model: string };
  fellBack: boolean;
  usage?: Usage;
}

/** One model call, trying each brain in the chain until one starts answering. */
async function runStep(deps: LoopDeps, spec: RunSpec, io: StepIo): Promise<StepResult> {
  const brains = deps.router.chain(deps.chain);
  if (brains.length === 0) {
    throw new NoBrainError("No brain is set up for this. Sign in with ChatGPT or add a Workers AI model in Settings → Brains.");
  }
  const specs = io.tools.map(toSpec);
  const failures: string[] = [];

  for (const [i, brain] of brains.entries()) {
    const attempt = new AbortController();
    const signal = spec.signal ? AbortSignal.any([spec.signal, attempt.signal]) : attempt.signal;
    let produced = false;
    let stepText = "";
    let statusSaid = false;
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    try {
      const it = brain
        .stream({ system: io.system, messages: io.messages, tools: specs, signal, effort: spec.effort })
        [Symbol.asyncIterator]();
      let first = true;
      while (true) {
        const next: IteratorResult<BrainEvent> = first ? await firstEvent(it, spec.firstEventMs, attempt) : await it.next();
        first = false;
        if (next.done) break;
        const ev = next.value;
        if (ev.type === "text") {
          produced = true;
          stepText += ev.text;
          io.say(ev.text);
        } else if (ev.type === "tool_start" || ev.type === "tool_call") {
          // The status line goes out at the first sign of a lookup: some
          // providers announce a tool call early, others only send it whole.
          const name = ev.type === "tool_start" ? ev.name : ev.call.name;
          const status = io.tools.find((t) => t.name === name)?.status;
          if (status && !statusSaid) {
            statusSaid = true;
            const speakable = !stepText && !io.alreadySaid();
            if (speakable) produced = true;
            io.emit({ type: "status", text: status, speakable });
          }
          if (ev.type === "tool_call") calls.push(ev.call);
        } else if (ev.type === "done") {
          usage = ev.usage;
        }
      }
      deps.router.markOk(brain);
      return { text: stepText, calls, brain: { provider: brain.provider, model: brain.model }, fellBack: i > 0, usage };
    } catch (err) {
      if (spec.signal?.aborted) throw err;
      deps.router.markFailed(brain, err);
      const reason = err instanceof Error ? err.message : String(err);
      // Words already reached the owner: switching brains mid-answer would garble it.
      if (produced) throw new BrainError(`The answer broke off: ${reason}`);
      failures.push(`${brainKey(brain)}: ${reason}`);
      const nextBrain = brains[i + 1];
      if (nextBrain) {
        const row = append(deps.sql, {
          actor: "system",
          kind: "brain.fallback",
          run_id: spec.runId,
          surface: spec.surface,
          body: { role: spec.role, from: brainKey(brain), to: brainKey(nextBrain), reason },
        });
        io.emit({ type: "row", row });
      }
    }
  }
  throw new NoBrainError(`No brain could answer. ${failures.join(" · ")}`);
}

async function firstEvent(it: AsyncIterator<BrainEvent>, ms: number, attempt: AbortController): Promise<IteratorResult<BrainEvent>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      attempt.abort();
      reject(new BrainError(`no answer within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([it.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTool(deps: LoopDeps, spec: RunSpec, call: ToolCall, emit: (e: LoopEvent) => void): Promise<string> {
  const tool = spec.tools.find((t) => t.name === call.name);
  append(deps.sql, {
    actor: "atlas",
    kind: "tool.call",
    run_id: spec.runId,
    surface: spec.surface,
    body: { call_id: call.id, name: call.name, input: call.input as never },
  });

  let res: ToolResult;
  if (!tool) {
    res = fail(`There's no tool called ${call.name}.`);
  } else {
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      res = fail(`Those arguments don't fit: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    } else {
      res = await withTimeout(
        tool.run(parsed.data as never, { ...deps.toolContext, run_id: spec.runId }),
        tool.timeoutMs ?? 20_000,
        `${tool.name} took too long and was stopped.`,
      ).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    }
  }

  const content = truncate(JSON.stringify(res.output ?? null), MAX_TOOL_OUTPUT);
  const row = append(deps.sql, {
    actor: "atlas",
    kind: "tool.result",
    run_id: spec.runId,
    surface: spec.surface,
    body: {
      call_id: call.id,
      name: call.name,
      ok: res.ok,
      output: truncate(content, 2_000),
      ...(res.receipt ? { receipt: res.receipt as never } : {}),
    },
  });
  if (res.receipt) emit({ type: "row", row });
  return content;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (cut, ${s.length - max} more characters)`;
}
