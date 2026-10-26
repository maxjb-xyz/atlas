// Atlas suggests automations (§13.4): when the owner has asked for much the
// same thing on three different days, a suggestion appears
// at the top of Automations. This compares the owner's own words with each
// other, in code; it never touches what the model says (rule 1). Make it
// opens the form filled in, and the owner decides the rest.

import { listAutomations, norm } from "./automations";
import type { Sql } from "./store/db";
import { getState, setState } from "./store/state";

export interface Suggestion {
  id: string;
  /** The latest way the owner put it. */
  said: string;
  /** The words compared, without the small ones. */
  words: string[];
  times: number;
  last_at: number;
  state: "open" | "dismissed" | "made";
  /** Counted by days (since 2026-10-26); one counted by hours before then isn't shown until it's asked for again. */
  days?: boolean;
}

/** The suggestion as the app shows it. */
export type SuggestionView = Pick<Suggestion, "id" | "said" | "times" | "last_at">;

/**
 * Asks on this many different days, in the owner's time zone, before Atlas suggests it. A habit shows over days;
 * asking a few times in one sitting (a retry, a test, the Jarvis bar's runs) is one occasion.
 */
export const SUGGEST_AFTER = 3;
const LOOK_BACK_MS = 30 * 86_400_000;
const ALIKE = 0.6;

const SMALL = new Set(
  "a an and are can could do for from give i if is it its let me my of on or please send show tell that the this to up us what whats with would you your".split(
    " ",
  ),
);

/**
 * Asking about what already happened ("why didn't you tell me", "did you
 * send it") is about one thing gone wrong, not something to do again, so it's
 * never suggested, however often it's asked.
 */
const ABOUT_THE_PAST =
  /^(why|how come|what happened|did you|didn ?t you|have you|haven ?t you|were you|was it|you forgot|you missed|you didn ?t)\b/;

/** The words that carry what was asked: lowercase, no small words, plurals folded. */
export function wordsOf(text: string): string[] {
  return [
    ...new Set(
      norm(text)
        .replace(/\$/g, "")
        .split(" ")
        .filter((w) => w.length > 2 && !SMALL.has(w))
        .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
    ),
  ];
}

export function alike(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const both = a.filter((w) => B.has(w)).length;
  return both / (a.length + b.length - both);
}

export const suggestions = (sql: Sql): Suggestion[] => getState<Suggestion[]>(sql, "suggestions") ?? [];

export const openSuggestions = (sql: Sql): SuggestionView[] =>
  suggestions(sql)
    .filter((s) => s.state === "open" && s.days && !ABOUT_THE_PAST.test(norm(s.said)))
    .sort((a, b) => b.last_at - a.last_at)
    .map(({ id, said, times, last_at }) => ({ id, said, times, last_at }));

/**
 * Looks at a message the owner just sent. Returns true when it opened or
 * refreshed a suggestion. Messages already covered by an automation, by a
 * suggestion the owner set aside, or too short or long to be a request, are
 * left alone.
 */
export function noticeAsk(sql: Sql, text: string, tz = "UTC", now = Date.now()): boolean {
  if (ABOUT_THE_PAST.test(norm(text))) return false;
  const words = wordsOf(text);
  if (words.length < 2 || words.length > 14 || text.length > 200) return false;
  const all = suggestions(sql);
  const known = all.find((s) => alike(s.words, words) >= ALIKE);
  if (known && known.state !== "open") return false;
  for (const a of listAutomations(sql)) {
    const covered = wordsOf(`${a.name} ${a.when.kind === "request" ? (a.when.phrase ?? "") : ""}`);
    if (alike(covered, words) >= ALIKE) return false;
  }
  const past = sql
    .exec<{ at: number; text: string }>(
      `SELECT at, json_extract(body, '$.text') AS text FROM log WHERE kind = 'message.in' AND actor = 'owner' AND at >= ? ORDER BY seq DESC LIMIT 1000`,
      now - LOOK_BACK_MS,
    )
    .toArray()
    .filter((r) => typeof r.text === "string" && alike(wordsOf(r.text), words) >= ALIKE);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const times = new Set(past.map((r) => day.format(r.at))).size;
  if (times < SUGGEST_AFTER) return false;
  const s: Suggestion = known
    ? { ...known, said: text.trim(), words, times, last_at: now, days: true }
    : { id: `sg_${now.toString(36)}`, said: text.trim(), words, times, last_at: now, state: "open", days: true };
  setState(sql, "suggestions", [...all.filter((x) => x.id !== s.id), s].slice(-50));
  return true;
}

/** The owner made it, or set it aside: either way it isn't suggested again. */
export function settleSuggestion(sql: Sql, id: string, state: "dismissed" | "made"): void {
  setState(
    sql,
    "suggestions",
    suggestions(sql).map((s) => (s.id === id ? { ...s, state } : s)),
  );
}
