// Open loops (VISION §10.4): silence can be news. A loop is something Atlas
// is waiting to hear by a time, on the one clock: "tell me if the landlord
// hasn't replied by Friday", a mail Atlas sent that asked something, a
// review someone is waiting on the owner for. The item that answers it
// (mail from the landlord, a reply in the thread) closes it as it comes in;
// at its time, one still open becomes an item for the intake, weighed like
// any other, the way an absence trigger works.

import { addressesIn, findPerson } from "./contacts";
import { personIn } from "./tasks";
import { type AgendaItem, createItem, finish, getItem, upcoming } from "./store/agenda";
import type { Json, Sql } from "./store/db";
import type { SenseItem } from "./store/log";
import { shortLocal } from "./time";

export interface LoopDetail {
  /** What it's about, in a few words: "the lease renewal". */
  about: string;
  /** Who it waits on: a person's name or address, or "owner" when someone waits on the owner. */
  waiting_on: string;
  /** The person record, when Atlas knows them. */
  person?: string;
  /** The thread an answer would come in on: a mail thread, an issue. */
  thread?: string;
  /** Who opened it: the owner asked, or Atlas did after sending something that asks. */
  opened_by: "owner" | "atlas";
  /** A fact to check before raising it (a review on GitHub), since the answer may not come as an item. */
  check?: { github_review?: { repo: string; number: number } };
}

export const detailOf = (i: AgendaItem): LoopDetail => (i.source.detail ?? {}) as unknown as LoopDetail;

export const openLoops = (sql: Sql): AgendaItem[] => upcoming(sql, 300).filter((i) => i.kind === "loop" && i.state === "scheduled");

/** A new loop on the clock. The caller schedules it. */
export function openLoop(
  sql: Sql,
  o: LoopDetail & { due_at: number; run_id?: string | null; log_id?: string | null; via: string },
): AgendaItem {
  const who = o.waiting_on === "owner" ? null : (findPerson(sql, "email", addressesIn(o.waiting_on)[0] ?? "") ?? null);
  const detail: LoopDetail = {
    about: o.about,
    waiting_on: o.waiting_on,
    opened_by: o.opened_by,
    ...(o.person || who ? { person: o.person ?? who!.id } : {}),
    ...(o.thread ? { thread: o.thread } : {}),
    ...(o.check ? { check: o.check } : {}),
  };
  return createItem(sql, {
    kind: "loop",
    title: o.waiting_on === "owner" ? `Waiting on you: ${o.about}` : `Waiting on ${o.waiting_on}: ${o.about}`,
    due_at: o.due_at,
    source: {
      via: o.via,
      ...(o.run_id ? { run_id: o.run_id } : {}),
      ...(o.log_id ? { log_id: o.log_id } : {}),
      detail: detail as unknown as Record<string, Json>,
    },
  });
}

/** Closes a loop: answered, or closed by the owner or Atlas. Returns the item to take off the clock. */
export function closeLoop(sql: Sql, id: string, why: string, o: { by: "owner" | "atlas"; run_id?: string | null }): AgendaItem | null {
  const i = getItem(sql, id);
  if (!i || i.kind !== "loop" || i.state !== "scheduled") return null;
  finish(sql, id, "done", o.run_id ?? null, { why, closed_by: o.by, ...(o.by === "owner" ? { by: "owner" } : {}) });
  return i;
}

/**
 * The loops an item answers as it comes in: from the person a loop waits
 * on (by their address or name, the way tasks match people), or in the
 * loop's thread. Only items from someone count: an invite naming the
 * landlord isn't the landlord replying. Returns the loops it closed.
 */
export function answered(sql: Sql, item: SenseItem, rowId: string, what: string): AgendaItem[] {
  if (item.source === "loop" || item.source === "calendar" || item.source === "location") return [];
  const from = typeof item.from === "string" ? item.from : "";
  const out: AgendaItem[] = [];
  for (const loop of openLoops(sql)) {
    const d = detailOf(loop);
    if (d.waiting_on === "owner") continue;
    const inThread = !!d.thread && !!item.thread && d.thread === item.thread && !!from;
    const fromThem = !!from && ((d.person && item.person === d.person) || personIn(sql, d.waiting_on, [from]) != null);
    if (!inThread && !fromThem) continue;
    const closed = closeLoop(sql, loop.id, `Answered: ${what.slice(0, 200)}`, { by: "atlas" });
    if (closed) {
      out.push(closed);
      sql.exec(`UPDATE log SET body = json_set(body, '$.closes', json(?)) WHERE id = ?`, JSON.stringify([loop.id]), rowId);
    }
  }
  return out;
}

/** A loop whose time came, as an item for the intake. */
export function dueItem(loop: AgendaItem, tz: string): SenseItem {
  const d = detailOf(loop);
  const since = shortLocal(new Date(loop.created_at), tz);
  return {
    source: "loop",
    event: "due",
    what:
      d.waiting_on === "owner"
        ? `Still waiting on the owner since ${since}: ${d.about}`
        : `No answer from ${d.waiting_on} since ${since}: ${d.about}${d.opened_by === "owner" ? " (the owner asked to be told)" : " (you opened this loop when you asked)"}`,
    key: `loop:${loop.id}`,
    ref: loop.id,
    ...(d.thread ? { thread: d.thread } : {}),
  };
}

/** Open loops for every prompt, so "what am I waiting on?" has an answer. */
export function loopsLine(sql: Sql, tz: string): string {
  const open = openLoops(sql).slice(0, 15);
  if (!open.length) return "";
  return `Open loops (waiting to hear by a time; loop_close when one's settled):\n${open
    .map((l) => `- ${l.title}, by ${shortLocal(new Date(l.due_at), tz)} (id ${l.id})`)
    .join("\n")}`;
}
