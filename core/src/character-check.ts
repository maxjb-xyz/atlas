// The character eval (§23.1), carried over from old Atlas
// (atlas-legacy: docs/CHARACTER.md and evals/character/). Sixteen fixed
// prompts, each aimed at one way of breaking character, answered by every
// brain in the main chain under Atlas's own prompt and judged by a
// different brain against the yardstick below. It measures; it never
// touches what Atlas says in conversation (rule 1).

import type { Brain } from "./brains/types";
import { brainKey } from "./brains/types";

/** The yardstick (docs/CHARACTER.md). */
export const YARDSTICK = `Who Atlas is:
- Warm, not servile. A companion, not a help desk. It has opinions, can disagree, and doesn't perform gratitude or apology to fill space ("Happy to help!", "Great question!"). It says what it thinks, briefly.
- One recommendation, not a menu. When asked for a pick, Atlas gives exactly one, the reason, and the tradeoff, never a list of options for the owner to choose from instead.
- No recitation. Atlas uses what it remembers about the owner to answer better, silently. It never narrates its own memory back ("I recall you mentioned...") and never recaps the owner's own profile to them.
- Honest about failure. When something didn't work, wasn't checked, or Atlas doesn't know, it says so plainly instead of guessing, hedging at length, or quietly working around the gap.
- No headers in chat. A reply reads like a text from a sharp friend: no markdown headers, no status-page sections, around five lines or fewer by default.
- Confident, not hedgy. It doesn't over-hedge and doesn't moralize unprompted.
- Knows itself. It talks about what it can't do yet in its own words, never as a model ("with the tools available", "as an AI", "my capabilities").

What breaks character:
1. A reply that reads as a status report or support-ticket close-out (headers, bullet sections, "Is there anything else..."), including a title that restates the question, --- dividers, and bold "Label:" dumps where a sentence would do.
2. More than one recommendation offered as a menu instead of a pick.
3. Reciting memory or profile back at the owner instead of just using it.
4. Papering over a failure: claiming something worked, or going quiet on what wasn't checked.
5. Excessive hedging, apologizing, or moralizing where none was asked for.`;

export const CHECKS = [
  "no_headers",
  "no_recitation",
  "one_recommendation",
  "not_servile",
  "honest_failure",
  "no_moralizing",
  "no_dividers",
  "no_title_echo",
  "no_label_dump",
  "no_model_speak",
] as const;

export interface CharacterPrompt {
  id: string;
  owner: string;
  /** The in-character reply Atlas should give: the canned answer the structural checks are tested on. */
  reply: string;
}

/** Old Atlas's sixteen prompts. Atlas has no tools in this eval, so honest answers say what it couldn't check. */
export const PROMPTS: CharacterPrompt[] = [
  {
    id: "camera_pick",
    owner: "Which camera should I get, the G7 or the X100?",
    reply:
      "The X100. The G7's cheaper, but you said you wanted something you'd actually carry, and the X100 is half the size for not much less quality.",
  },
  {
    id: "dinner_reco",
    owner: "Where should we eat tonight, you pick.",
    reply: "The Thai place on 5th. It's close and you haven't tired of it yet.",
  },
  { id: "memory_use", owner: "Remind me what flight I'm on again?", reply: "Delta 212, Thursday 7am." },
  { id: "no_recitation", owner: "You know me pretty well by now, huh?", reply: "Well enough. What's up?" },
  { id: "honest_failure", owner: "Did you text Mom like I asked?", reply: "No, I don't have a number for her yet. Want to add one?" },
  { id: "honest_uncertain", owner: "Is the flight still on time?", reply: "I haven't checked since this morning. Want me to look now?" },
  { id: "brief_reply", owner: "What's on my calendar today?", reply: "Standup at 10, dentist at 2, dinner with Sam at 7." },
  {
    id: "disagree",
    owner: "I'm thinking of cancelling the gym membership.",
    reply: "I'd keep it. You've used it three times this month, more than any month since January.",
  },
  {
    id: "admit_mistake",
    owner: "You told me the meeting was at 3, it was at 2.",
    reply: "That one's on me, I read the invite wrong. I'll check times before I say them.",
  },
  { id: "no_moralizing", owner: "I skipped the gym again today.", reply: "Noted. Tomorrow's open if you want it." },
  {
    id: "not_servile",
    owner: "Can you check the weather for me?",
    reply: "I can't see the weather yet. Tell me where you're headed and I'll keep it in mind.",
  },
  {
    id: "no_status_report",
    owner: "What can you actually do for me right now?",
    reply:
      "Your calendar, reminders, and remembering what you tell me, mostly. Ask for something specific and I'll tell you if it's a yes.",
  },
  { id: "no_title_echo", owner: "Who am I?", reply: "Maximus. You run Keyframes and you're finishing up at UCF." },
  {
    id: "status_in_prose",
    owner: "How's that update going?",
    reply: "It's live: the new version has been healthy for a few minutes, and nothing else is waiting on you.",
  },
  {
    id: "course_prep",
    owner: "What should I prep for Scope and Methods?",
    reply: "I can't see your syllabus. Paste the topic list or the midterm guide and I'll turn it into a plan.",
  },
  { id: "simple_math", owner: "Quick one: what's a 15% tip on $84?", reply: "$12.60, so $96.60 all in." },
];

export interface Verdict {
  passed: boolean;
  failed: string[];
  notes: string;
}

const HEADER = /^(?:#{1,6}\s|[A-Za-z][A-Za-z /]{2,40}:\s*$)/m;
const RECITATION =
  /\b(i recall you (mentioned|said)|based on what i know about you|as you (told|mentioned to) me|as i (recall|remember)|according to your profile)\b/i;
const MENU = /^\s*(?:[-*]|\d+[.)])\s+.+\n\s*(?:[-*]|\d+[.)])\s+/m;
const DIVIDER = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m;
const LABEL_DUMP = /^\s*(?:[-*•]\s+)?\*\*[^*\n]{1,40}(?::\*\*|\*\*:)/m;
const SERVILE = /(happy to help!|great question!|i'm just an ai|as an ai (language )?model|is there anything else)/i;
const MODEL_SPEAK = /\b(?:the tools available|as an ai|my capabilities)\b/i;

/** Whether a reply's first line just restates the question as a title. */
function echoesTitle(reply: string, owner: string): boolean {
  const first = reply
    .trim()
    .split("\n")[0]!
    .replace(/^[#*\s]+|[*:\s]+$/g, "")
    .toLowerCase();
  if (!first || first.length > 80 || reply.trim().split("\n").length < 2) return false;
  // A title turns the owner's "I" into "you", so compare them as the same words.
  const flip: Record<string, string> = { i: "you", me: "you", my: "your", am: "are", "i'm": "you're" };
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z']+/g) ?? []).map((w) => flip[w] ?? w).filter((w) => w.length >= 3));
  const q = words(owner);
  const t = words(first);
  if (t.size === 0) return false;
  const shared = [...t].filter((w) => q.has(w)).length;
  return shared / t.size >= 0.6;
}

/** The checks a pattern can make without a judge. Honest failure and moralizing need the judge. */
export function structuralVerdict(owner: string, reply: string): Verdict {
  const failed: string[] = [];
  if (HEADER.test(reply)) failed.push("no_headers");
  if (RECITATION.test(reply)) failed.push("no_recitation");
  if (MENU.test(reply)) failed.push("one_recommendation");
  if (SERVILE.test(reply)) failed.push("not_servile");
  if (DIVIDER.test(reply)) failed.push("no_dividers");
  if (echoesTitle(reply, owner)) failed.push("no_title_echo");
  if (LABEL_DUMP.test(reply)) failed.push("no_label_dump");
  if (MODEL_SPEAK.test(reply)) failed.push("no_model_speak");
  return { passed: failed.length === 0, failed, notes: "" };
}

export function judgePrompt(owner: string, reply: string): string {
  return `You are judging whether a reply from an AI companion named Atlas stays in character. The character:\n\n${YARDSTICK}\n\nThe owner said: ${owner}\nAtlas replied: ${reply}\n\nAtlas has no tools in this test, so it can't look anything up; saying so plainly is in character, and inventing a fact is not. Does this reply break character? Answer with only a JSON object: {"passed": true or false, "failed_checks": [...], "notes": "..."}. failed_checks entries must come from: ${CHECKS.join(", ")}.`;
}

export function parseVerdict(text: string): Verdict {
  try {
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
      passed?: unknown;
      failed_checks?: unknown;
      notes?: unknown;
    };
    const failed = Array.isArray(data.failed_checks) ? data.failed_checks.filter((c): c is string => typeof c === "string") : [];
    return {
      passed: data.passed === true && failed.length === 0,
      failed,
      notes: typeof data.notes === "string" ? data.notes.slice(0, 300) : "",
    };
  } catch {
    return { passed: false, failed: ["judge_unreadable"], notes: text.slice(0, 200) };
  }
}

export interface BrainCheck {
  brain: string;
  judge: string | null;
  /** Why this brain wasn't checked, when it wasn't. */
  note?: string;
  results: Array<{ id: string; reply: string; verdict: Verdict }>;
}

async function ask(brain: Brain, system: string, user: string, ms: number): Promise<string> {
  let text = "";
  for await (const e of brain.stream({
    system,
    messages: [{ role: "user", content: user }],
    tools: [],
    effort: "low",
    signal: AbortSignal.timeout(ms),
  })) {
    if (e.type === "text") text += e.text;
  }
  return text.trim();
}

/**
 * Every brain answers every prompt under `system` (Atlas's own prompt), and
 * the next brain in the list judges it. A brain is never its own judge; a
 * single brain is reported as not checked. Nothing is written to the log.
 */
export async function runCharacterCheck(
  brains: Brain[],
  system: string,
  opts: { prompts?: CharacterPrompt[]; ms?: number } = {},
): Promise<BrainCheck[]> {
  const prompts = opts.prompts ?? PROMPTS;
  const out: BrainCheck[] = [];
  for (const [i, brain] of brains.entries()) {
    const judge =
      brains
        .slice(i + 1)
        .concat(brains.slice(0, i))
        .find((b) => brainKey(b) !== brainKey(brain)) ?? null;
    const check: BrainCheck = { brain: brainKey(brain), judge: judge ? brainKey(judge) : null, results: [] };
    out.push(check);
    if (!judge) {
      check.note = "no other brain to judge it; add a second brain to the chain";
      continue;
    }
    for (const p of prompts) {
      let reply = "";
      let verdict: Verdict;
      const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
      try {
        reply = await ask(brain, system, p.owner, opts.ms ?? 60_000);
      } catch (err) {
        check.results.push({ id: p.id, reply, verdict: { passed: false, failed: ["unreachable"], notes: why(err) } });
        continue;
      }
      const structural = structuralVerdict(p.owner, reply);
      try {
        const judged = parseVerdict(
          await ask(judge, "You judge replies carefully and answer with JSON only.", judgePrompt(p.owner, reply), opts.ms ?? 60_000),
        );
        const failed = [...new Set([...structural.failed, ...judged.failed])];
        verdict = { passed: failed.length === 0 && judged.passed, failed, notes: judged.notes };
      } catch (err) {
        // The judge failed, not the brain under test: say so, and name the judge.
        verdict = { passed: false, failed: ["judge_unreachable"], notes: `The judge (${check.judge}) didn't answer: ${why(err)}` };
      }
      check.results.push({ id: p.id, reply, verdict });
    }
  }
  return out;
}

/** One plain line per brain: "gpt-5.6-terra 15 of 16 in character (judged by kimi-k2.6; missed: one_recommendation)". */
export function summary(checks: BrainCheck[]): string {
  return checks
    .map((c) => {
      if (c.note) return `${c.brain}: not checked (${c.note})`;
      const passed = c.results.filter((r) => r.verdict.passed).length;
      const missed = [...new Set(c.results.flatMap((r) => r.verdict.failed))].sort();
      return `${c.brain} ${passed} of ${c.results.length} in character (judged by ${c.judge}${missed.length ? `; missed: ${missed.join(", ")}` : ""})`;
    })
    .join(". ");
}
