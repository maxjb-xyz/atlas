// Compaction (§4.1). A run sees the summary of the conversation so far and
// every message since it. When that passes about 70% of the context window,
// two runs replace the older part: first a silent pass that saves what
// matters as records, then a summary written by Atlas for itself. Both are
// ordinary runs of the one loop, each ending in a saved state, and the
// summary is its own row in the log. The messages stay in the log and in
// recall; they only leave the context.

import { CONTEXT_TOKENS, latestSummary, sinceSummary, toMessages, tokens, withMessage } from "./context";
import type { LoopDeps, LoopResult, RunSpec } from "./loop";
import { runLoop } from "./loop";
import type { Sql } from "./store/db";
import { append, type LogRow } from "./store/log";
import { endRun, startRun } from "./store/runs";
import { recall, remember } from "./tools/memory";

/** Compaction starts when a run's context passes this share of the window. */
export const COMPACT_AT = 0.7;
/** What stays in view afterwards: the newest messages, up to this share of the window. */
export const KEEP = 0.25;
/** At least this many of the newest messages always stay in view. */
export const KEEP_MESSAGES = 6;

export interface CompactionPlan {
  /** The messages leaving the context, oldest first. */
  rows: LogRow[];
  through_seq: number;
  /** The context's size when compaction started, in tokens. */
  tokens_before: number;
}

/**
 * Whether the context needs compacting, and where to cut. The cut never
 * falls between something the owner said and Atlas's answer to it.
 */
export function planCompaction(sql: Sql, opts: { window?: number; systemTokens: number }): CompactionPlan | null {
  const window = opts.window ?? CONTEXT_TOKENS;
  const rows = sinceSummary(sql);
  const sizes = rows.map((r) => tokens(String(r.body.text ?? "")));
  const total = opts.systemTokens + sizes.reduce((a, b) => a + b, 0);
  if (total < window * COMPACT_AT) return null;

  let keep = 0;
  let kept = 0;
  while (keep < rows.length && (keep < KEEP_MESSAGES || kept + sizes[rows.length - 1 - keep]! <= window * KEEP)) {
    kept += sizes[rows.length - 1 - keep]!;
    keep += 1;
  }
  let cut = rows.length - keep;
  // Keep a question and its answer on the same side of the cut, by keeping the question too.
  while (cut > 0 && cut < rows.length && rows[cut]!.kind === "message.out" && rows[cut]!.run_id === rows[cut - 1]!.run_id) cut -= 1;
  if (cut < 2) return null;
  const leaving = rows.slice(0, cut);
  return { rows: leaving, through_seq: leaving[leaving.length - 1]!.seq, tokens_before: total };
}

export const SAVE_NOTE = `[Atlas's memory, not the owner] The conversation above is about to leave your view; a summary will take its place, and recall will still find the messages. Before it goes, save what matters with remember: what the owner told you about themselves, their people, places, plans, preferences and commitments that you'd want later and haven't saved yet (the standing facts are already saved). Don't save small talk, guesses, or anything already on the calendar or in a reminder. Saving nothing is fine. When you're done, reply with one word: done.`;

export const SUMMARY_NOTE = `[Atlas's memory, not the owner] Write the summary that will replace the conversation above in your view. Write it for yourself, in plain sentences: what was talked about, what was decided, what you promised or are in the middle of, open questions, and how the owner seemed and what they care about right now. Carry over whatever still matters from your earlier summary. Use absolute dates, not "today" or "tomorrow". Stay under 350 words, and write only the summary.`;

export interface CompactDeps {
  sql: Sql;
  loop: LoopDeps;
  /** The system prompt for a run with no surface, including the summary in force. */
  system: string;
}

export interface CompactionOutcome {
  summary: LogRow | null;
  save: LoopResult;
  write: LoopResult;
}

/** Runs the save pass and the summary for a plan. */
export async function compact(deps: CompactDeps, plan: CompactionPlan): Promise<CompactionOutcome> {
  const { sql } = deps;
  const conversation = toMessages(plan.rows);
  const spec = (runId: string, note: string, extra: Partial<RunSpec>): RunSpec => ({
    runId,
    role: "main",
    surface: "none",
    system: deps.system,
    messages: withMessage(conversation, note),
    tools: [],
    budget: { steps: 1, ms: 120_000 },
    joiner: "\n\n",
    effort: "low",
    firstEventMs: 25_000,
    ...extra,
  });

  const saveRun = startRun(sql, { actor: "atlas", trigger: "compaction", surface: "none", role: "main" });
  const save = await runLoop(
    deps.loop,
    spec(saveRun, SAVE_NOTE, { tools: [remember, recall], budget: { steps: 12, ms: 180_000 } }),
    () => {},
  );
  endRun(sql, saveRun, save.state, save.steps, { step: "save", ...(save.error ? { error: save.error } : {}) });

  const writeRun = startRun(sql, { actor: "atlas", trigger: "compaction", surface: "none", role: "main" });
  const write = await runLoop(deps.loop, spec(writeRun, SUMMARY_NOTE, {}), () => {});
  let summary: LogRow | null = null;
  if (write.state === "replied" && write.text.trim()) {
    summary = append(sql, {
      actor: "atlas",
      kind: "context.summary",
      run_id: writeRun,
      body: {
        text: write.text.trim(),
        from_seq: plan.rows[0]!.seq,
        through_seq: plan.through_seq,
        messages: plan.rows.length,
        tokens_before: plan.tokens_before,
        save_run: saveRun,
        replaces: latestSummary(sql)?.seq ?? null,
        ...(write.brain ? { brain: `${write.brain.provider}:${write.brain.model}` } : {}),
      },
    });
  }
  endRun(sql, writeRun, summary ? "replied" : "failed", write.steps, {
    step: "summary",
    ...(summary ? {} : { error: write.error ?? "The brain wrote an empty summary." }),
  });
  return { summary, save, write };
}
