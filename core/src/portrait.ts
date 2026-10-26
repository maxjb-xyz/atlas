// The portrait (VISION §5.1, §5.2): Atlas's own picture of the person it serves, rewritten nightly from what it
// learned, kept in the cached part of every turn, and shown to the owner in Library, who can correct it. Each rewrite
// also says, in a line or two, what Atlas learned that day, which the front page shows the next morning.
//
// One item on the one clock (§4.3), each night. A night with nothing new from the owner costs nothing: no turn runs.

import { type AgendaItem, createItem } from "./store/agenda";
import type { Sql } from "./store/db";
import { getState, setState } from "./store/state";
import { addLocalDays, startOfLocalDay, zonedParts, zonedToUtc } from "./time";

export interface Portrait {
  /** Atlas's picture of the owner, in plain sentences. */
  text: string;
  /** What it learned on the day the portrait was written: a few short lines, newest day only. */
  learned: string[];
  at: number;
  /** "owner" when the owner wrote it in Library: the next rewrite keeps their words as true. */
  by: "atlas" | "owner";
  /** The last log row the rewrite read, so the next one starts after it. */
  through_seq: number;
}

/** The longest a portrait may be, so it stays a cheap part of every turn's prompt. */
export const PORTRAIT_CHARS = 2_000;
/** When the nightly rewrite runs, local time: after the day, before the morning brief. */
const AT = { h: 3, m: 40 };

export function getPortrait(sql: Sql): Portrait | null {
  return getState<Portrait>(sql, "portrait");
}

export function savePortrait(sql: Sql, p: Omit<Portrait, "at"> & { at?: number }): Portrait {
  const kept: Portrait = {
    ...p,
    text: p.text.trim().slice(0, PORTRAIT_CHARS),
    learned: p.learned
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5),
    at: p.at ?? Date.now(),
  };
  setState(sql, "portrait", kept);
  return kept;
}

/** The night's rewrite on the clock, made when there's none. */
export function ensurePortrait(sql: Sql, tz: string, now = Date.now()): AgendaItem | null {
  const open = sql.exec(`SELECT id FROM agenda WHERE kind = 'portrait' AND state IN ('scheduled', 'running') LIMIT 1`).toArray()[0];
  if (open) return null;
  const today = zonedParts(startOfLocalDay(new Date(now), tz), tz);
  let at = zonedToUtc(today.year, today.month, today.day, AT.h, AT.m, 0, tz);
  if (at.getTime() <= now) {
    const next = zonedParts(addLocalDays(new Date(now), 1, tz), tz);
    at = zonedToUtc(next.year, next.month, next.day, AT.h, AT.m, 0, tz);
  }
  return createItem(sql, { kind: "portrait", title: "Rewrite what I know about you", due_at: at.getTime(), source: { via: "memory" } });
}

/** The owner's words since the last rewrite, newest last, within a budget: what the night reads. */
export function ownerSince(sql: Sql, seq: number, chars = 24_000): { text: string; through: number } {
  const rows = sql
    .exec<{ seq: number; at: number; kind: string; text: string }>(
      `SELECT seq, at, kind, json_extract(body, '$.text') AS text FROM log
       WHERE seq > ? AND kind IN ('message.in', 'message.out') AND json_extract(body, '$.job') IS NULL AND json_extract(body, '$.text') IS NOT NULL
       ORDER BY seq DESC LIMIT 400`,
      seq,
    )
    .toArray();
  const through = rows[0]?.seq ?? seq;
  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = `${r.kind === "message.in" ? "Owner" : "Atlas"}: ${String(r.text).replace(/\s+/g, " ").slice(0, 600)}`;
    if (used + line.length > chars) break;
    out.push(line);
    used += line.length;
  }
  return { text: out.reverse().join("\n"), through };
}

export const PORTRAIT_NOTE = (o: { previous: Portrait | null; facts: string; said: string }) =>
  [
    "[Atlas's memory, not the owner] Rewrite your portrait of the owner: who they are, what fills their days and weeks, the people who matter to them, how they like you to be, and what's on their mind lately. It sits in front of you in every conversation, so keep it to what helps you help them, in plain sentences, under 250 words.",
    o.previous
      ? o.previous.by === "owner"
        ? `The owner wrote your portrait themselves; their words are true, so keep them and add only what's new:\n${o.previous.text}`
        : `Your portrait so far:\n${o.previous.text}`
      : "You have no portrait yet.",
    o.facts ? `What you know for good:\n${o.facts}` : "",
    `What was said since your last rewrite:\n${o.said}`,
    "Then say what you learned about them from that, in one to three short lines, each a plain sentence they'd recognize ('You've started training for a half marathon.'). Only what's new and about them, never about yourself or the conversation; if nothing new, write none.",
    "Answer in exactly this shape, with nothing before or after:\nPORTRAIT:\n<the portrait>\nLEARNED:\n- <a line>\n- <a line>",
  ]
    .filter(Boolean)
    .join("\n\n");

/** Reads the rewrite's two parts. Null when the answer isn't in that shape, so a bad night keeps the old portrait. */
export function readPortrait(answer: string): { text: string; learned: string[] } | null {
  const m = /PORTRAIT:\s*([\s\S]*?)\s*LEARNED:\s*([\s\S]*)$/i.exec(answer.trim());
  if (!m || !m[1]!.trim()) return null;
  const learned = m[2]!
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l && !/^none\.?$/i.test(l));
  return { text: m[1]!.trim(), learned };
}
