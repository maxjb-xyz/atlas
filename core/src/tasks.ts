// Tasks (VISION §5.1): anything to do, as a record. A task is open, done
// or dropped, may have a deadline (one reminder on the clock, §4.3), and
// may say when it fits: a kind of place ("a pharmacy"), a place ("the
// office"), a person ("next time I talk to Sam"), or plain words ("when
// the new season's out"). The intake checks open tasks against what comes
// in (core/src/agent/senses.ts), and Agenda lists them under To do.
// Errands were their own kind on the clock until 2026-10-23; they're tasks
// that fit at a place, and `fromErrands` moves the old ones over once.

import { kindWords } from "./maps";
import { createItem, finish, type AgendaItem, upcoming } from "./store/agenda";
import type { Json, Sql } from "./store/db";
import { getState, setState } from "./store/state";
import { type AtlasRecord, correctRecord, createRecord, findRecords, getRecord, type RecordSource } from "./store/records";

export type TaskStatus = "open" | "done" | "dropped";

/** When a task fits. Any of them, or none (then it's a plain to-do). */
export interface Fits {
  /** A kind of place, as place_find takes it: "grocery", "pharmacy", "florist", "leisure=park". */
  kind?: string;
  /** A particular place: a saved place's name, or a name or address. */
  place?: string;
  /** A person: next time the owner is in touch with them. */
  person?: string;
  /** Plain words, for anything else: "when the new season's out", "next time I'm in Tampa". */
  words?: string;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  /** When it fits, in words, or null for a plain to-do. */
  fits: string | null;
  by: number | null;
  created_at: number;
}

export const statusOf = (r: AtlasRecord): TaskStatus =>
  r.fields.status === "done" || r.fields.status === "dropped" ? r.fields.status : "open";
export const fitsOf = (r: AtlasRecord): Fits => (r.fields.fits && typeof r.fields.fits === "object" ? (r.fields.fits as Fits) : {});

/** When a task fits, in words: "at a grocery store", "next time you're in touch with Sam". Null when it's a plain to-do. */
export function fitsText(f: Fits): string | null {
  const parts = [
    f.place ? `at ${f.place}` : f.kind ? `at ${kindWords(f.kind)}` : "",
    f.person ? `next time you're in touch with ${f.person}` : "",
    f.words ?? "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** A task by id, if it's open. */
export function getTaskOpen(sql: Sql, id: string): AtlasRecord | null {
  const r = getRecord(sql, id);
  return r && r.type === "task" && r.state === "active" && statusOf(r) === "open" ? r : null;
}

/** Open tasks, oldest first. A task saved without a status (by `remember`) is open. */
export const openTasks = (sql: Sql): AtlasRecord[] =>
  findRecords(sql, "task")
    .filter((r) => statusOf(r) === "open")
    .sort((a, b) => a.learned_at - b.learned_at);

export function taskView(r: AtlasRecord): TaskView {
  return {
    id: r.id,
    title: r.name,
    status: statusOf(r),
    fits: fitsText(fitsOf(r)),
    by: typeof r.fields.by === "number" ? r.fields.by : null,
    created_at: r.learned_at,
  };
}

/** A new open task; a deadline puts one reminder on the clock, linked to it. Returns the task and the reminder to schedule. */
export function addTask(
  sql: Sql,
  o: { title: string; fits?: Fits; by?: number | null; source: RecordSource },
): { task: AtlasRecord; reminder: AgendaItem | null } {
  const fits = Object.fromEntries(Object.entries(o.fits ?? {}).filter(([, v]) => typeof v === "string" && v.trim())) as Fits;
  const task = createRecord(sql, {
    type: "task",
    name: o.title,
    fields: { status: "open", ...(Object.keys(fits).length ? { fits: fits as unknown as Json } : {}), ...(o.by ? { by: o.by } : {}) },
    source: o.source,
  });
  const reminder = o.by
    ? createItem(sql, {
        kind: "reminder",
        title: o.title,
        due_at: o.by,
        source: { via: "task", ...(o.source.run_id ? { run_id: o.source.run_id } : {}), detail: { task: task.id } },
      })
    : null;
  return { task, reminder };
}

/**
 * Marks a task done or dropped, as a correction (so History has it and it
 * can be undone). Its deadline's reminder is taken off the clock, and
 * returned for the caller to unschedule.
 */
export function closeTask(
  sql: Sql,
  id: string,
  status: Exclude<TaskStatus, "open">,
  source: RecordSource,
): { task: AtlasRecord; history: number; reminders: AgendaItem[] } | null {
  const r = getRecord(sql, id);
  if (!r || r.type !== "task" || r.state !== "active" || statusOf(r) !== "open") return null;
  const h = correctRecord(sql, id, { fields: { status } }, `marked ${status}`, source);
  const reminders = remindersOf(sql, id);
  for (const item of reminders) finish(sql, item.id, "cancelled", source.run_id ?? null, { why: `The task is ${status}.` });
  return { task: getRecord(sql, id)!, history: h.history_seq, reminders };
}

const words = (t: string): string[] =>
  t
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const EMAIL = /[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+/g;

/**
 * Who a person is, as far as Atlas knows: the task's own words for them,
 * and the names and addresses on the person records that go by them
 * ("Doug" finds "Doug Henderson", with doug@acme.com in its details).
 */
export function personKeys(sql: Sql, person: string): { names: string[][]; emails: Set<string> } {
  const asked = words(person);
  const names: string[][] = asked.length ? [asked] : [];
  const emails = new Set<string>((person.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  if (!asked.length) return { names, emails };
  for (const r of findRecords(sql, "person")) {
    const own = words(r.name);
    if (r.fields.is_owner || !asked.every((w) => own.includes(w))) continue;
    names.push(own);
    // Its details: an email anywhere, and other names it goes by.
    for (const [k, v] of Object.entries(r.fields)) {
      for (const x of Array.isArray(v) ? v : [v]) {
        if (typeof x !== "string") continue;
        for (const e of x.match(EMAIL) ?? []) emails.add(e.toLowerCase());
        if (/name|alias|aka|nick|goes_by|called/i.test(k) && !x.includes("@")) names.push(words(x));
      }
    }
  }
  return { names: names.filter((n) => n.length), emails };
}

/**
 * The first of `who` (lines like "Doug Henderson <doug@acme.com>", an
 * address, or a handle) that is this person, by an address Atlas knows for
 * them, or by every word of one of their names. Null when none is: then
 * it's for `decide` to judge ("D. Henderson" may still be Doug).
 */
export function personIn(sql: Sql, person: string, who: string[]): string | null {
  const keys = personKeys(sql, person);
  for (const line of who) {
    const addresses = (line.match(EMAIL) ?? []).map((e) => e.toLowerCase());
    if (addresses.some((e) => keys.emails.has(e))) return line;
    const have = new Set(words(line.replace(/@[^\s>]+/g, " ")));
    if (keys.names.some((n) => n.every((w) => have.has(w)))) return line;
  }
  return null;
}

/** A task's deadline reminders still on the clock. */
export const remindersOf = (sql: Sql, id: string): AgendaItem[] =>
  upcoming(sql, 200).filter((i) => i.kind === "reminder" && i.state === "scheduled" && i.source.detail?.task === id);

/**
 * Once: errands from before tasks (agenda items of kind "errand") become
 * tasks that fit at their kind of place or place, keeping what was said;
 * one with a deadline gets its reminder. Returns the errands' items, now
 * ended, and the reminders to schedule.
 */
export function fromErrands(sql: Sql): { ended: AgendaItem[]; reminders: AgendaItem[] } {
  if (getState(sql, "tasks_from_errands")) return { ended: [], reminders: [] };
  const ended: AgendaItem[] = [];
  const reminders: AgendaItem[] = [];
  for (const e of upcoming(sql, 500).filter((i) => i.kind === "errand" && i.state === "scheduled")) {
    const d = e.source.detail ?? {};
    const deadline = e.due_at < 8_000_000_000_000_000 ? e.due_at : null;
    const { reminder } = addTask(sql, {
      title: e.title,
      fits: {
        ...(typeof d.place_kind === "string" ? { kind: d.place_kind } : {}),
        ...(typeof d.place === "string" ? { place: d.place } : {}),
      },
      by: deadline && deadline > Date.now() ? deadline : null,
      source: {
        via: "errand",
        ...(e.source.run_id ? { run_id: e.source.run_id } : {}),
        ...(e.source.log_id ? { log_id: e.source.log_id } : {}),
      },
    });
    if (reminder) reminders.push(reminder);
    finish(sql, e.id, "cancelled", null, { why: "Errands are tasks now." });
    ended.push(e);
  }
  setState(sql, "tasks_from_errands", { at: Date.now(), moved: ended.length });
  return { ended, reminders };
}
