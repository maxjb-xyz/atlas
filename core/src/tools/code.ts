// Code Mode (§9.1): Atlas writes one small program that calls many of its
// own tools, and it runs in a Dynamic Worker (Cloudflare Sandbox's other
// environment). Inside, each tool this run has is a function,
// `atlas.<tool>(input)`, and every call goes through the tool itself: the
// same input checks, kinds and approvals as a direct call, and its receipt
// in the console. The program itself has no network and no bindings.

import { DynamicWorkerExecutor, normalizeCode } from "@cloudflare/codemode";
import { z } from "zod";
import { defineTool, fail, type Tool, type ToolResult } from "./types";

/** The most tool calls one program may make. */
export const MAX_CALLS = 60;
/** How long one program may run. */
const TIMEOUT_MS = 5 * 60_000;

/** Tools a program can't call: itself, and a nested helper (a program runs in this turn). */
const NOT_IN_CODE = new Set(["code_run", "delegate"]);

export const codeRun = defineTool({
  name: "code_run",
  kind: "look",
  status: "Working through it.",
  timeoutMs: TIMEOUT_MS + 30_000,
  description: [
    "Run one small JavaScript program that calls many of your tools at once, when a task needs a lot of steps: look up ten things and compare them, search several queries in parallel, go through a list and save each item, read many pages and keep what matters.",
    "Write `code` as an async arrow function. Each of your other tools is a function on `atlas` taking the same input object as the tool and returning its output, such as `await atlas.web_search({ query: 'pho near UCF' })` or `await atlas.recall({ query: 'Riverside' })`. A failed call returns `{ error }`. Use Promise.all for things that can run together.",
    "Return what you need from the run; console.log lines come back too. The program has no network of its own: reach the web through atlas.web_search and atlas.web_fetch.",
    `Every call counts as if you made it yourself: things that ask the owner still ask, and the owner sees each one's receipt. At most ${MAX_CALLS} calls and five minutes.`,
  ].join(" "),
  input: z.object({
    code: z
      .string()
      .min(10)
      .max(40_000)
      .describe("An async arrow function, like: async () => { const a = await atlas.recall({ query: 'x' }); return a; }"),
  }),
  async run(input, ctx) {
    if (!ctx.loader || !ctx.tools) return fail("Programs can't run from here.");
    const tools = ctx.tools.filter((t) => !NOT_IN_CODE.has(t.name));
    let calls = 0;
    const called: Record<string, number> = {};
    const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
    for (const t of tools) {
      fns[t.name] = async (args: unknown) => {
        if (++calls > MAX_CALLS) throw new Error(`The program made more than ${MAX_CALLS} tool calls, so it was stopped.`);
        called[t.name] = (called[t.name] ?? 0) + 1;
        const res = await callTool(t, args ?? {}, ctx);
        await ctx.record?.(t.name, args, res);
        return res.ok ? res.output : { error: (res.output as { error?: unknown })?.error ?? res.output };
      };
    }
    const executor = new DynamicWorkerExecutor({ loader: ctx.loader, timeout: TIMEOUT_MS, globalOutbound: null });
    let out: { result: unknown; error?: string; logs?: string[] };
    try {
      out = await executor.execute(normalizeCode(input.code), [{ name: "atlas", fns }]);
    } catch (err) {
      return fail(`The program couldn't run: ${err instanceof Error ? err.message : String(err)}`);
    }
    const summary = Object.entries(called)
      .map(([n, c]) => `${n} ×${c}`)
      .join(", ");
    const output = {
      ...(out.error ? { error: out.error } : { result: out.result ?? null }),
      ...(out.logs?.length ? { logs: out.logs.slice(-50) } : {}),
      calls: calls > MAX_CALLS ? MAX_CALLS : calls,
      ...(summary ? { called: summary } : {}),
    };
    return {
      ok: !out.error,
      output,
      receipt: {
        text: `Ran a program · ${Math.min(calls, MAX_CALLS)} ${calls === 1 ? "call" : "calls"}${summary ? ` (${summary})` : ""}`.slice(
          0,
          160,
        ),
      },
    };
  },
});

/** One call from a program: the input checked by the tool's own schema, then the tool itself. */
async function callTool(t: Tool, args: unknown, ctx: Parameters<Tool["run"]>[1]): Promise<ToolResult> {
  const parsed = t.input.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Those arguments don't fit ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
    );
  }
  try {
    return await t.run(parsed.data as never, ctx);
  } catch (err) {
    return fail(`${t.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
