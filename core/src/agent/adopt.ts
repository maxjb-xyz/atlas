// Jobs from the first design (§8.3 before 2026-10-25) carry over once, with what
// they had: the goal, what each step found and what the owner said, as the new
// job's notes; what it kept; its folder, which is the same. The old state is
// marked as carried over (storage only grows) and its open question leaves Inbox.

import type { FileRef } from "../protocol";
import type { Sql } from "../store/db";
import { getState, setState } from "../store/state";
import { clip, type JobDesk } from "./jobs";
import { inboxDone } from "./views";

interface OldJob {
  id: string;
  title: string;
  goal: string;
  asked_in: string | null;
  brain: string;
  phase: string;
  plan: Array<{ id: string; title: string; kind: string; state: string; result?: string }>;
  log: Array<{ at: number; who: string; text: string }>;
  question: { text: string; log: string } | null;
  deadline?: number | null;
  started_at: number;
  carried?: boolean;
}

const ENDED = ["done", "failed", "cancelled"];

export async function adoptOldJobs(sql: Sql, desk: JobDesk): Promise<number> {
  const old = sql
    .exec<{ key: string }>(`SELECT key FROM state WHERE key LIKE 'goal:%'`)
    .toArray()
    .map((r) => [r.key, getState<OldJob>(sql, r.key as `goal:${string}`)] as const)
    .filter((x): x is readonly [string, OldJob] => x[1] != null && !ENDED.includes(x[1].phase) && !x[1].carried);
  for (const [key, g] of old) {
    const steps = g.plan
      .filter((s) => s.state !== "skipped")
      .map((s) => `- ${s.title} (${s.state})${s.result ? `: ${clip(s.result.replace(/\s+/g, " "), 600)}` : ""}`);
    const said = g.log
      .filter((e) => e.who === "owner")
      .slice(-12)
      .map((e) => `- ${new Date(e.at).toISOString().slice(0, 16)}: ${clip(e.text, 600)}`);
    const history = [
      steps.length ? `What I'd done so far:\n${steps.join("\n")}` : "",
      said.length ? `What the owner said along the way, in their words:\n${said.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    // The old job's question is answered by the new job's turn instead, so it leaves Inbox.
    if (g.question?.log) inboxDone(sql, g.question.log);
    await desk.adopt({
      id: g.id,
      title: g.title,
      goal: g.goal,
      asked_in: g.asked_in,
      asked_by: null,
      brain: g.brain,
      deadline: g.deadline ?? null,
      history: clip(history, 11_000),
      files: [] as FileRef[],
      started_at: g.started_at,
      question: g.question?.text ?? null,
    });
    setState(sql, key as `goal:${string}`, { ...g, carried: true, phase: "cancelled" });
  }
  return old.length;
}
