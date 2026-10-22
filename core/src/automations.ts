// Automations (VISION §13): one object. When [a trigger happens], do [these
// steps], allowed to [use these webhooks], report [here]. The contract is a
// zod schema shared by the model's tool, the form in the app and the store.
// Each automation that runs on a clock has one agenda item for its next run
// (§4.3), so Agenda shows it and the one clock wakes it.

import { z } from "zod";
import { type Json, newId, parse, type Sql } from "./store/db";
import { append } from "./store/log";
import { addLocalDays, zonedParts, zonedToUtc } from "./time";

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "a time like 08:00");
/** Days of the week, 0 for Sunday to 6 for Saturday. Empty means every day. */
const Days = z.array(z.number().int().min(0).max(6)).max(7).default([]);

export const Trigger = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("request"),
    phrase: z
      .string()
      .max(80)
      .optional()
      .describe("What the owner says or types to run it, like 'goodnight' or 'focus for $duration'. Words starting with $ are inputs."),
  }),
  z.object({ kind: z.literal("schedule"), at: HHMM.describe("Local time, HH:mm."), days: Days }),
  z.object({
    kind: z.literal("watch"),
    url: z.string().url().startsWith("https://").max(500).describe("The page to watch."),
    every_hours: z.number().min(1).max(168).default(6).describe("How often to look, in hours."),
    matters: z.string().min(1).max(300).describe("What kind of change matters, in plain words: 'the price drops below $300'."),
  }),
  z.object({
    kind: z.literal("absence"),
    nothing_about: z.string().min(1).max(120).describe("Words that would show it happened, like 'workout' or 'landlord replied'."),
    for_days: z.number().int().min(1).max(60).describe("How many days without it before this runs."),
    at: HHMM.describe("When to check each day, local HH:mm."),
  }),
  z.object({
    kind: z.literal("event"),
    on: z
      .enum(["automation", "calendar"])
      .default("automation")
      .describe("What it follows: another automation finishing, or the calendar changing."),
    after: z.string().max(64).optional().describe("With on: automation, the automation (its id) it runs after."),
    about: z
      .string()
      .max(120)
      .optional()
      .describe(
        "With on: calendar, words an event's title, place or notes must have for its change to count, like 'Riverside'. Empty for any change.",
      ),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const Step = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("say"),
    text: z.string().min(1).max(1_000).describe("Fixed words for the owner, as written. $inputs fill in."),
  }),
  z.object({
    kind: z.literal("webhook"),
    webhook: z.string().min(1).max(80).describe("The webhook's name."),
    message: z.string().max(1_000).optional(),
  }),
  z.object({
    kind: z.literal("atlas"),
    instructions: z
      .string()
      .min(1)
      .max(2_000)
      .describe("What Atlas does with judgment at this point, as a complete note: what to look at and what to say."),
  }),
]);
export type Step = z.infer<typeof Step>;

export const Report = z.enum(["thread", "inbox", "silent"]);
export type Report = z.infer<typeof Report>;

/** What the model and the form fill in. */
export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(60),
  about: z.string().max(300).default(""),
  when: Trigger,
  do: z.array(Step).min(1).max(12),
  report: Report.default("thread").describe("Where what it says goes: the thread, Inbox, or nowhere but History."),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** Who made an automation: the owner in the form, Atlas from what the owner said, or Atlas's defaults (the routines). */
export type Maker = "owner" | "atlas" | "default";

export interface Automation extends AutomationInput {
  id: string;
  /** "on" runs on its trigger; "paused" runs only by hand or as a test. */
  state: "on" | "paused";
  made_by: Maker;
  /** Who changed it last. When it's Atlas, it waits for a test run before it can be turned on. */
  changed_by: "owner" | "atlas";
  /** Webhooks it may call without asking, granted when the owner turns it on (§13.1: allowed to). */
  allowed: string[];
  created_at: number;
  updated_at: number;
  /** The last test run since the last change, or null. */
  tested_at: number | null;
  /** Failures in a row (§13.4). */
  fails: number;
  /** Why it paused itself, when it did. */
  paused_why: string | null;
  /** What it keeps between runs: a watched page's last text, for one. */
  memo: Record<string, Json>;
}

type Raw = {
  id: string;
  name: string;
  about: string;
  trigger: string;
  steps: string;
  report: string;
  state: string;
  made_by: string;
  changed_by: string;
  allowed: string;
  created_at: number;
  updated_at: number;
  tested_at: number | null;
  fails: number;
  paused_why: string | null;
  memo: string;
};

const fromRaw = (r: Raw): Automation => ({
  id: r.id,
  name: r.name,
  about: r.about,
  when: parse(r.trigger, { kind: "request" }) as Trigger,
  do: parse(r.steps, []) as Step[],
  report: (Report.safeParse(r.report).data ?? "thread") as Report,
  state: r.state === "on" ? "on" : "paused",
  made_by: r.made_by === "owner" || r.made_by === "default" ? r.made_by : "atlas",
  changed_by: r.changed_by === "atlas" ? "atlas" : "owner",
  allowed: parse(r.allowed, []),
  created_at: r.created_at,
  updated_at: r.updated_at,
  tested_at: r.tested_at,
  fails: r.fails,
  paused_why: r.paused_why,
  memo: parse(r.memo, {}),
});

export function getAutomation(sql: Sql, id: string): Automation | null {
  const r = sql.exec<Raw>(`SELECT * FROM automations WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function listAutomations(sql: Sql): Automation[] {
  return sql.exec<Raw>(`SELECT * FROM automations ORDER BY created_at`).toArray().map(fromRaw);
}

export function findAutomation(sql: Sql, nameOrId: string): Automation | null {
  const want = nameOrId.trim().toLowerCase();
  return getAutomation(sql, nameOrId) ?? listAutomations(sql).find((a) => a.name.toLowerCase() === want) ?? null;
}

/** Whether it waits for a test run before it can be turned on: Atlas made or changed it, and nobody has seen it run since. */
export const needsTest = (a: Pick<Automation, "changed_by" | "tested_at">) => a.changed_by === "atlas" && a.tested_at == null;

/**
 * Saves a new automation or a change. The owner's own (from the form) start
 * on, and the default routines start off without needing a test run; Atlas's start paused, and a change by Atlas
 * pauses one until there's a test run, so nothing Atlas wrote runs
 * unattended before the owner has seen it.
 */
export function saveAutomation(sql: Sql, input: AutomationInput, by: Maker, id?: string): Automation {
  const old = id ? getAutomation(sql, id) : null;
  if (id && !old) throw new Error("That automation isn't there any more.");
  const clash = listAutomations(sql).find((a) => a.id !== old?.id && a.name.toLowerCase() === input.name.toLowerCase());
  if (clash) throw new Error(`There's already an automation called ${input.name}.`);
  const phrase = input.when.kind === "request" ? input.when.phrase : undefined;
  if (phrase) {
    const taken = listAutomations(sql).find(
      (a) => a.id !== old?.id && a.when.kind === "request" && a.when.phrase && norm(a.when.phrase) === norm(phrase),
    );
    if (taken) throw new Error(`"${phrase}" already runs ${taken.name}.`);
  }
  if (input.when.kind === "event" && input.when.on === "automation") {
    if (!input.when.after) throw new Error("Say which automation it runs after.");
    if (input.when.after === old?.id) throw new Error("An automation can't run after itself.");
  }
  const now = Date.now();
  const atlas = by === "atlas";
  // The default routines start off: setup offers them, and the owner turns on the ones they want (§13.4, §22).
  const state = atlas ? "paused" : (old?.state ?? (by === "default" ? "paused" : "on"));
  // What it may call without asking was granted for the steps the owner saw; a change takes it back until they turn it on again.
  const allowed = !atlas && state === "on" ? webhookNames(input) : [];
  if (old) {
    sql.exec(
      `UPDATE automations SET name = ?, about = ?, trigger = ?, steps = ?, report = ?, state = ?, allowed = ?, changed_by = ?, updated_at = ?, tested_at = NULL, fails = 0, paused_why = NULL, memo = ? WHERE id = ?`,
      input.name,
      input.about,
      JSON.stringify(input.when),
      JSON.stringify(input.do),
      input.report,
      state,
      JSON.stringify(allowed),
      atlas ? "atlas" : "owner",
      now,
      // A new trigger starts looking afresh.
      JSON.stringify(JSON.stringify(old.when) === JSON.stringify(input.when) ? old.memo : {}),
      old.id,
    );
  } else {
    id = newId("au");
    sql.exec(
      `INSERT INTO automations (id, name, about, trigger, steps, report, state, made_by, changed_by, allowed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.about,
      JSON.stringify(input.when),
      JSON.stringify(input.do),
      input.report,
      state,
      by,
      atlas ? "atlas" : "owner",
      JSON.stringify(allowed),
      now,
      now,
    );
  }
  const saved = getAutomation(sql, id!)!;
  append(sql, {
    actor: by === "default" ? "system" : by,
    kind: "automation.change",
    body: { automation_id: saved.id, name: saved.name, change: old ? "changed" : "made", state: saved.state },
  });
  return saved;
}

/** Turns an automation on or off. Turning on grants its webhook steps; it needs a test run first when Atlas made or changed it. */
export function setAutomationState(sql: Sql, id: string, on: boolean, by: "owner" | "atlas", why?: string): Automation {
  const a = getAutomation(sql, id);
  if (!a) throw new Error("That automation isn't there any more.");
  if (on && needsTest(a)) {
    throw new Error(`${a.name} needs a test run first, so you can see what it would do before it runs on its own.`);
  }
  sql.exec(
    `UPDATE automations SET state = ?, allowed = ?, fails = CASE WHEN ? THEN 0 ELSE fails END, paused_why = ?, updated_at = ? WHERE id = ?`,
    on ? "on" : "paused",
    JSON.stringify(on ? webhookNames(a) : []),
    on ? 1 : 0,
    on ? null : (why ?? null),
    Date.now(),
    id,
  );
  append(sql, {
    actor: by,
    kind: "automation.change",
    body: { automation_id: id, name: a.name, change: on ? "on" : "paused", ...(why ? { why } : {}) },
  });
  return getAutomation(sql, id)!;
}

export function deleteAutomation(sql: Sql, id: string): Automation | null {
  const a = getAutomation(sql, id);
  if (!a) return null;
  sql.exec(`DELETE FROM automations WHERE id = ?`, id);
  append(sql, { actor: "owner", kind: "automation.change", body: { automation_id: id, name: a.name, change: "deleted" } });
  return a;
}

/** Notes how a run went: a test run counts as seen; failures in a row are counted. Returns the new count. */
export function noteRun(sql: Sql, id: string, o: { test: boolean; ok: boolean; memo?: Record<string, Json> }): number {
  const a = getAutomation(sql, id);
  if (!a) return 0;
  const fails = o.test ? a.fails : o.ok ? 0 : a.fails + 1;
  sql.exec(
    `UPDATE automations SET fails = ?, tested_at = CASE WHEN ? THEN ? ELSE tested_at END, memo = ? WHERE id = ?`,
    fails,
    o.test ? 1 : 0,
    Date.now(),
    JSON.stringify(o.memo ?? a.memo),
    id,
  );
  return fails;
}

/** What an automation keeps between runs, such as a watched page's last text. */
export function setMemo(sql: Sql, id: string, memo: Record<string, Json>): void {
  sql.exec(`UPDATE automations SET memo = ? WHERE id = ?`, JSON.stringify(memo), id);
}

const webhookNames = (a: Pick<AutomationInput, "do">) => [
  ...new Set(a.do.filter((s): s is Extract<Step, { kind: "webhook" }> => s.kind === "webhook").map((s) => s.webhook.toLowerCase())),
];

// --- when it runs --------------------------------------------------------------------------

/** Whether an automation's trigger runs on the clock (and so has an agenda item). */
export const onClock = (t: Trigger) =>
  t.kind === "schedule" || t.kind === "watch" || t.kind === "absence" || (t.kind === "event" && t.on === "calendar");

/** How often a calendar trigger reads the calendar for changes. Each read is at most one sign-in, and Atlas keeps a copy. */
export const CALENDAR_EVERY_MS = 30 * 60_000;

/** The next time a clock trigger fires after `from`, in the owner's time zone, or null for triggers that don't run on the clock. */
export function nextRun(t: Trigger, from: Date, tz: string): Date | null {
  if (t.kind === "watch") return new Date(from.getTime() + t.every_hours * 3600_000);
  if (t.kind === "event") return t.on === "calendar" ? new Date(from.getTime() + CALENDAR_EVERY_MS) : null;
  if (t.kind !== "schedule" && t.kind !== "absence") return null;
  const days = t.kind === "schedule" ? t.days : [];
  const [h, m] = t.at.split(":").map(Number) as [number, number];
  for (let i = 0; i <= 8; i++) {
    const day = zonedParts(addLocalDays(from, i, tz), tz);
    const at = zonedToUtc(day.year, day.month, day.day, h, m, 0, tz);
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    if (at.getTime() > from.getTime() && (!days.length || days.includes(weekday))) return at;
  }
  return null;
}

// --- on request ----------------------------------------------------------------------------

/** How a phrase is compared: case, punctuation and extra spaces don't count. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The automation whose phrase is exactly what the owner said, with its
 * inputs filled in ("focus for $duration" matches "Focus for 45 minutes").
 * Only a whole, exact match counts: anything else goes to Atlas as usual.
 * Paused automations don't answer to their phrase.
 */
export function matchPhrase(sql: Sql, said: string): { automation: Automation; inputs: Record<string, string> } | null {
  const text = norm(said);
  if (!text || text.length > 120) return null;
  for (const a of listAutomations(sql)) {
    if (a.state !== "on" || a.when.kind !== "request" || !a.when.phrase) continue;
    const words = norm(a.when.phrase).split(" ");
    const names: string[] = [];
    const pattern = words.map((w) => (w.startsWith("$") && w.length > 1 ? (names.push(w.slice(1)), "(.+?)") : escape(w))).join(" ");
    const m = new RegExp(`^${pattern}$`, "u").exec(text);
    if (m) return { automation: a, inputs: Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) };
  }
  return null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fills $inputs into a step's words. */
export const fill = (text: string, inputs: Record<string, string>) => text.replace(/\$(\w+)/g, (all, n: string) => inputs[n] ?? all);

// --- in words ------------------------------------------------------------------------------

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function daysText(days: number[]): string {
  const d = [...new Set(days)].sort();
  if (!d.length || d.length === 7) return "every day";
  if (d.join() === "1,2,3,4,5") return "weekdays";
  if (d.join() === "0,6") return "weekends";
  return d.map((x) => DAY_NAMES[x]).join(", ");
}

/** The trigger in a few words, for cards, receipts and the model. */
export function whenText(t: Trigger, names: (id: string) => string | null = () => null): string {
  switch (t.kind) {
    case "request":
      return t.phrase ? `When you say "${t.phrase}", or press Run` : "When you press Run, or ask";
    case "schedule":
      return `At ${t.at}, ${daysText(t.days)}`;
    case "watch":
      return `Every ${t.every_hours} h, looks at ${new URL(t.url).host} for: ${t.matters}`;
    case "absence":
      return `Nothing about "${t.nothing_about}" for ${t.for_days} ${t.for_days === 1 ? "day" : "days"} (checked at ${t.at})`;
    case "event":
      if (t.on === "calendar") return t.about ? `When an event about "${t.about}" changes on your calendar` : "When your calendar changes";
      return `After ${(t.after && names(t.after)) ?? "another automation"} finishes`;
  }
}

export function stepText(s: Step): string {
  switch (s.kind) {
    case "say":
      return `Say: "${s.text}"`;
    case "webhook":
      return `Call ${s.webhook}${s.message ? ` with "${s.message}"` : ""}`;
    case "atlas":
      return `Atlas: ${s.instructions}`;
  }
}
