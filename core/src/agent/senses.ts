// Awareness without the cost (VISION §10.3). Every sense event goes through
// three steps: rules (cheap and fixed), then `decide` (Clef: does it matter
// to anything open?), then a run of Atlas's own, only when it matters, which
// speaks up with `nudge` or ends in silence. Rhythm moments (start of day,
// evening, a look before leaving for an event) are agenda items on the one
// clock and go straight to Atlas, who may also stay silent. Each step leaves
// an `awareness` row, so History says what was decided and why, and the
// owner's reactions to nudges are logged against their kind. This desk also
// keeps the situation's cache current (core/src/situation.ts).

import { type Decider } from "../brains/decide";
import type { Calendar } from "../calendar/types";
import { nextRun } from "../automations";
import { KINDS, type PlaceKind } from "../maps";
import { type AgendaItem, createItem, finish, getItem, rearm, upcoming } from "../store/agenda";
import { parse, type Sql } from "../store/db";
import { append, type LogRow } from "../store/log";
import { findRecords } from "../store/records";
import { readSettings, type Settings, writeSettings } from "../store/settings";
import { getState, setState } from "../store/state";
import { cache, placeOf, refresh as refreshCache, situationLines, TRAVEL_AHEAD_MS } from "../situation";
import { clockLocal, shortLocal, startOfLocalDay, zoneOf } from "../time";
import { minutes } from "../maps";
import { z } from "zod";
import { defineTool, fail, type MapsApi, type Tool, type ToolContext } from "../tools/types";

/** What Atlas may speak up about on its own; each has a switch in Settings → Notifications → Speaking up. */
export type NudgeKind = "errands" | "leave" | "morning" | "evening" | "noticed";

export const NUDGE_WORDS: Record<NudgeKind, string> = {
  errands: "errands near you",
  leave: "when to leave for events",
  morning: "the start of day",
  evening: "the evening",
  noticed: "other things Atlas notices",
};

/** A nudge Atlas sent, and how the owner took it. */
export interface Nudge {
  /** The message's log row. */
  id: string;
  kind: NudgeKind;
  about?: string;
  at: number;
  text: string;
  reaction?: "replied" | "thanks" | "stop" | "ignored" | "opened" | "dismissed";
}

/** The owner's next message within this long is their reaction to a nudge. */
export const REACT_MS = 30 * 60_000;
/** A nudge nobody reacted to in this long was ignored. */
export const IGNORED_MS = 2 * 3_600_000;
/** How sure `decide` must be that an event matters before Atlas wakes. */
export const MATTERS = 0.5;
/** The same event at the same place within this long is a duplicate. */
const DUPLICATE_MS = 10 * 60_000;
/** On the move, the most often a move wakes Atlas. */
export const MOVE_COOLDOWN_MS = 20 * 60_000;
/** The leave look comes this long before the leave-by time. */
export const LEAVE_LEAD_MS = 10 * 60_000;
/** The owner counts as using Atlas when they've said something this recently: the weather and travel are kept current then. */
const ACTIVE_MS = 2 * 3_600_000;

export const nudges = (sql: Sql): Nudge[] => getState<Nudge[]>(sql, "nudges") ?? [];
const saveNudges = (sql: Sql, all: Nudge[]) => setState(sql, "nudges", all.slice(-40));

export function isOn(s: Settings, k: NudgeKind): boolean {
  const v = s.speaking[k];
  return typeof v === "boolean" ? v : v.on;
}

export interface SenseDeps {
  sql: Sql;
  /** Maps and weather, or null where they can't be reached (tests without a fake). */
  maps(): MapsApi | null;
  calendar(): Calendar | null;
  clock: ToolContext["clock"];
  decider(): Decider | null;
  /** A run of Atlas's own, with the note, the nudge tool and looks. Resolves when the run ends. */
  wake(o: { trigger: string; note: string; kind: NudgeKind; about?: string }): Promise<{ run_id: string; nudged: boolean; error?: string }>;
  rows(rows: LogRow[]): void;
  /** The situation changed: views showing it ask again. */
  changed(): void;
}

export class SenseDesk {
  #refreshing: Promise<void> | null = null;
  #again = false;

  constructor(private readonly d: SenseDeps) {}

  #log(body: Record<string, unknown>, run_id: string | null = null): LogRow {
    const row = append(this.d.sql, { actor: "system", kind: "awareness", run_id, body });
    this.d.rows([row]);
    return row;
  }

  /** Whether the owner said something lately. */
  #active(now = Date.now()): boolean {
    return this.d.sql.exec(`SELECT 1 FROM log WHERE kind = 'message.in' AND at > ? LIMIT 1`, now - ACTIVE_MS).toArray().length > 0;
  }

  // --- the situation's cache ------------------------------------------------------------------------

  /**
   * Brings the situation up to date, one refresh at a time (a call during
   * one runs once more after it). `full` adds the weather and travel time,
   * which are looked at only while they're needed.
   */
  refresh(full = true): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;
      return this.#refreshing;
    }
    const run = async () => {
      do {
        this.#again = false;
        const settings = readSettings(this.d.sql);
        await refreshCache({
          sql: this.d.sql,
          settings,
          calendar: this.d.calendar(),
          maps: this.d.maps(),
          full: full && this.#needed(settings),
        });
        await this.#armLeave(settings);
      } while (this.#again);
      this.d.changed();
    };
    this.#refreshing = run()
      .catch((err: unknown) =>
        console.error(JSON.stringify({ at: "situation.refresh", error: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  /** The weather and travel are worth looking at while the owner uses Atlas, or an event with a place is coming. */
  #needed(settings: Settings, now = Date.now()): boolean {
    if (this.#active(now)) return true;
    const c = cache(this.d.sql);
    void settings;
    return c.events.some(
      (e) =>
        !e.all_day && placeOf(e) && new Date(e.start).getTime() - now < TRAVEL_AHEAD_MS + 3_600_000 && new Date(e.start).getTime() > now,
    );
  }

  /** The refresh's place on the clock: one item, put back each time, every 15 minutes while it's needed, else every two hours. */
  async armTick(now = Date.now()): Promise<void> {
    const open = upcoming(this.d.sql, 200).find((i) => i.kind === "situation");
    const at = now + (this.#needed(readSettings(this.d.sql), now) ? 15 * 60_000 : 2 * 3_600_000);
    if (open && open.state === "scheduled" && open.due_at <= at) return;
    const item = open
      ? rearm(this.d.sql, open.id, at)!
      : createItem(this.d.sql, { kind: "situation", title: "Keep the situation current", due_at: at, source: { via: "senses" } });
    await this.d.clock.schedule(item);
  }

  /** The clock's tick (the item is already leased): refresh, note ignored nudges, and come back. */
  async tick(item: AgendaItem): Promise<void> {
    const now = Date.now();
    await this.refresh(true);
    this.#ignored(now);
    const at = now + (this.#needed(readSettings(this.d.sql), now) ? 15 * 60_000 : 2 * 3_600_000);
    await this.d.clock.schedule(rearm(this.d.sql, item.id, at)!);
  }

  // --- step by step, for each sense event ---------------------------------------------------------------

  /** Takes what a sense just logged through the three steps. Never throws: a failure is logged with its words. */
  async sensed(rows: LogRow[]): Promise<void> {
    for (const row of rows) {
      const ev = String(row.body.event ?? "");
      if (!["arrived", "left", "moved"].includes(ev)) continue;
      try {
        await this.#consider(row);
      } catch (err) {
        this.#log({
          of: row.id,
          event: describe(row),
          step: "rules",
          outcome: "failed",
          why: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async #consider(row: LogRow): Promise<void> {
    const t0 = Date.now();
    const settings = readSettings(this.d.sql);
    const event = describe(row);
    const quiet = (step: "rules" | "decide", why: string, extra: Record<string, unknown> = {}) =>
      this.#log({ of: row.id, event, step, outcome: step === "rules" ? "quiet" : "not relevant", why, ms: Date.now() - t0, ...extra });

    // 1. Rules: cheap and fixed.
    if (!isOn(settings, "errands") && !isOn(settings, "noticed")) {
      quiet("rules", "Speaking up about errands and other things is off.");
      return;
    }
    // Arriving or leaving the same place twice in a few minutes is the edge of a place, not news. (Moves have their own cool-down.)
    const place = (row.body.place as { id?: string } | undefined)?.id;
    const dup =
      place &&
      this.d.sql
        .exec(
          `SELECT 1 FROM log WHERE kind = 'sense' AND seq < ? AND at > ? AND json_extract(body, '$.event') = ? AND COALESCE(json_extract(body, '$.place.id'), '') = ? LIMIT 1`,
          row.seq,
          row.at - DUPLICATE_MS,
          String(row.body.event),
          place,
        )
        .toArray().length;
    if (dup) {
      quiet("rules", "The same happened a few minutes ago.");
      return;
    }
    // On the move, Atlas looks at most every twenty minutes; leaving a place always counts, since that's the moment.
    if (row.body.event === "moved") {
      const looked = this.d.sql
        .exec(
          `SELECT 1 FROM log WHERE kind = 'awareness' AND json_extract(body, '$.step') = 'woke' AND at > ? LIMIT 1`,
          row.at - MOVE_COOLDOWN_MS,
        )
        .toArray().length;
      if (looked) {
        quiet("rules", "Atlas looked a few minutes ago; on the move it looks at most every twenty minutes.");
        return;
      }
    }
    const open = this.#openThings(settings);
    if (!open.length) {
      quiet("rules", "Nothing open it could matter to.");
      return;
    }

    // 2. Decide: does it matter to anything open?
    const decider = this.d.decider();
    let matched = open;
    let scores: Record<string, number> | null = null;
    let why = "";
    if (decider) {
      const state = `${event}\n\n${situationLines(this.d.sql, settings)}`;
      const questions = Object.fromEntries(open.slice(0, 30).map((o) => [o.id, { instructions: o.question }]));
      try {
        scores = await decider.yesNo(state.slice(0, 4_000), questions, AbortSignal.timeout(8_000));
        matched = open.filter((o) => (scores![o.id] ?? 0) >= MATTERS);
      } catch (err) {
        why = `decide didn't answer (${err instanceof Error ? err.message : String(err)}), so Atlas looked itself`;
      }
    } else {
      why = "there's no decide role here, so Atlas looked itself";
    }
    const top = scores
      ? Object.fromEntries(Object.entries(scores).map(([k, v]) => [titleOf(open, k), Math.round(v * 100) / 100]))
      : undefined;
    if (!matched.length) {
      quiet("decide", "It doesn't matter to anything open.", top ? { scores: top } : {});
      return;
    }

    // 3. Atlas, only now, with the event and what it matched.
    const errand = matched.find((m) => m.kind === "errands");
    const kind: NudgeKind = errand ? "errands" : "noticed";
    const note = [
      `[Atlas's senses, not the owner] ${event}.`,
      `It may matter to: ${matched.map((m) => m.text).join("; ")}.`,
      errand
        ? "For an errand, find a place on their way (place_find with on_the_way_to, usually home, unless the situation says they're going elsewhere), and suggest the best one by name with how far off the way it is, asking whether they still need it."
        : "",
      reactionsLine(this.d.sql, kind),
      "Decide whether telling the owner now would help them. If it would, use nudge once, in a sentence or two, the way you'd text a friend. If it wouldn't (they don't need it now, it's late, they're busy, you'd be guessing), don't nudge: end with a few words for your own log saying why. Silence is right more often than not.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = await this.d.wake({ trigger: `sense:${row.id}`, note, kind, ...(errand ? { about: errand.id } : {}) });
    this.#log(
      {
        of: row.id,
        event,
        step: "woke",
        outcome: out.error ? "failed" : out.nudged ? "nudged" : "silent",
        why: out.error ?? (why || `It may matter to ${matched.map((m) => m.title).join(", ")}.`),
        ms: Date.now() - t0,
        ...(top ? { scores: top } : {}),
      },
      out.run_id,
    );
  }

  /** What an event could matter to: open errands, and commitments, reminders and promises coming up. */
  #openThings(settings: Settings): Array<{ id: string; kind: NudgeKind; title: string; text: string; question: string }> {
    const out: Array<{ id: string; kind: NudgeKind; title: string; text: string; question: string }> = [];
    if (isOn(settings, "errands")) {
      for (const e of upcoming(this.d.sql, 200)
        .filter((i) => i.kind === "errand" && i.state === "scheduled")
        .slice(0, 20)) {
        const k = e.source.detail?.place_kind;
        const where =
          typeof k === "string" && k in KINDS
            ? KINDS[k as PlaceKind].words
            : typeof e.source.detail?.place === "string"
              ? e.source.detail.place
              : "";
        out.push({
          id: e.id,
          kind: "errands",
          title: e.title,
          text: `the errand "${e.title}"${where ? ` (at ${where})` : ""} (id ${e.id})`,
          question: `The owner has an open errand: "${e.title}"${where ? `, done at ${where}` : ""}. Given this event, is now a good moment to suggest it: are they leaving somewhere and heading on, or passing near such a place?`,
        });
      }
    }
    if (isOn(settings, "noticed")) {
      const soon = Date.now() + 86_400_000;
      for (const i of upcoming(this.d.sql, 100)
        .filter((x) => (x.kind === "reminder" || x.kind === "promise") && x.state === "scheduled" && x.due_at < soon)
        .slice(0, 5)) {
        out.push({
          id: i.id,
          kind: "noticed",
          title: i.title,
          text: `the ${i.kind} "${i.title}" (due ${shortLocal(new Date(i.due_at), zoneOf(settings))})`,
          question: `The owner has a ${i.kind} coming up: "${i.title}". Does this event change anything about it, so they'd want to hear about it now?`,
        });
      }
      for (const r of findRecords(this.d.sql, "commitment").slice(0, 5)) {
        out.push({
          id: r.id,
          kind: "noticed",
          title: r.name,
          text: `the commitment "${r.name}"`,
          question: `The owner has a commitment: "${r.name}"${typeof r.fields.fact === "string" ? ` (${r.fields.fact})` : ""}. Does this event matter to it, so they'd want to hear about it now?`,
        });
      }
    }
    return out;
  }

  // --- rhythm moments ---------------------------------------------------------------------------------

  /** Puts the start of day and the evening on the clock at their times, or takes them off. */
  async armRhythm(now = new Date()): Promise<void> {
    const settings = readSettings(this.d.sql);
    const tz = zoneOf(settings);
    for (const moment of ["morning", "evening"] as const) {
      const open = upcoming(this.d.sql, 200).find((i) => i.kind === "rhythm" && i.source.detail?.moment === moment);
      const s = settings.speaking[moment];
      if (!s.on) {
        if (open) {
          await this.d.clock.unschedule(open);
          finish(this.d.sql, open.id, "cancelled", null, { by: "owner" });
        }
        continue;
      }
      const at = nextRun({ kind: "schedule", at: s.at, days: [] }, now, tz)!.getTime();
      // One that's due or under way is the clock's to run (a cold start calls this before the alarm's own wake does).
      if (open && (open.due_at === at || open.state === "running" || open.due_at <= now.getTime())) continue;
      const item = open
        ? rearm(this.d.sql, open.id, at)!
        : createItem(this.d.sql, {
            kind: "rhythm",
            title: moment === "morning" ? "Start of day" : "Evening",
            due_at: at,
            source: { via: "senses", detail: { moment } },
          });
      await this.d.clock.schedule(item);
    }
  }

  /** A look before leaving for the next event with a place, ten minutes before leave-by, once per event. */
  async #armLeave(settings: Settings): Promise<void> {
    const t = cache(this.d.sql).travel;
    // A look that's running is the moment's own to finish.
    const open = upcoming(this.d.sql, 200).filter(
      (i) => i.kind === "rhythm" && i.source.detail?.moment === "leave" && i.state === "scheduled",
    );
    for (const o of open) {
      // A leave look for an event that's no longer next (moved, cancelled) is dropped.
      if (!t || o.source.detail?.event_id !== t.event_id || !isOn(settings, "leave")) {
        await this.d.clock.unschedule(o);
        finish(this.d.sql, o.id, "cancelled", null, { why: "The event isn't next any more." });
      }
    }
    if (!t || !isOn(settings, "leave") || t.start <= Date.now()) return;
    // Once per event: one that already ran isn't made again.
    const ran = this.d.sql
      .exec(
        `SELECT 1 FROM agenda WHERE kind = 'rhythm' AND json_extract(source, '$.detail.event_id') = ? AND state IN ('done', 'running') LIMIT 1`,
        t.event_id,
      )
      .toArray().length;
    if (ran) return;
    const at = Math.max(Date.now() + 60_000, t.leave_by - LEAVE_LEAD_MS);
    const mine = open.find(
      (o) => o.source.detail?.event_id === t.event_id && o.state === "scheduled" && getItem(this.d.sql, o.id)?.state === "scheduled",
    );
    if (mine && Math.abs(mine.due_at - at) < 60_000) return;
    const item = mine
      ? rearm(this.d.sql, mine.id, at)!
      : createItem(this.d.sql, {
          kind: "rhythm",
          title: `Leave for ${t.title}`,
          due_at: at,
          source: { via: "senses", detail: { moment: "leave", event_id: t.event_id, start: t.start } },
        });
    await this.d.clock.schedule(item);
  }

  /** A rhythm moment came due (the item is already leased): Atlas looks, and may stay silent. Start of day and evening come back tomorrow. */
  async moment(item: AgendaItem): Promise<void> {
    const t0 = Date.now();
    const moment = String(item.source.detail?.moment ?? "");
    await this.refresh(true);
    const settings = readSettings(this.d.sql);
    const tz = zoneOf(settings);
    const kind: NudgeKind = moment === "leave" ? "leave" : moment === "evening" ? "evening" : "morning";
    const said = saidToday(this.d.sql, tz);
    let note: string;
    if (kind === "leave") {
      const t = cache(this.d.sql).travel;
      if (!t || t.event_id !== item.source.detail?.event_id) {
        finish(this.d.sql, item.id, "cancelled", null, { why: "The event isn't next any more." });
        this.#log({
          moment,
          event: item.title,
          step: "rules",
          outcome: "quiet",
          why: "The event isn't next any more.",
          ms: Date.now() - t0,
        });
        return;
      }
      note = [
        `[Atlas's clock, not the owner] It's nearly time to leave for "${t.title}" at ${clockLocal(new Date(t.start), tz)} (${t.location}): about ${minutes(t.s)} by car from ${t.from_what === "here" ? "where they are" : "home"}${t.traffic ? " with traffic" : ", typical time with no live traffic"}, so leave by ${clockLocal(new Date(t.leave_by), tz)}.`,
        "If they're already there or on the way (see the situation), or the event clearly doesn't need them to go, don't nudge. Otherwise nudge once, short: when to leave and how long it takes.",
        reactionsLine(this.d.sql, kind),
      ].join("\n\n");
    } else {
      note = [
        `[Atlas's clock, not the owner] It's the ${kind === "morning" ? "start of the day" : "evening"}: a look at ${kind === "morning" ? "the day ahead" : "today and tomorrow"}, which may end in silence.`,
        `Look at the situation, the calendar, reminders, errands and the weather. If something is worth telling the owner now (${kind === "morning" ? "a first meeting and when to leave, rain later, an errand that fits the day" : "something early tomorrow, something left undone today"}), nudge once with it, in a few lines. If nothing is, don't nudge.`,
        said.length ? `You've already said today (never say it again):\n${said.map((s) => `- ${s}`).join("\n")}` : "",
        reactionsLine(this.d.sql, kind),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const out = await this.d.wake({ trigger: `rhythm:${item.id}`, note, kind });
    this.#log(
      {
        moment,
        event: item.title,
        step: "woke",
        outcome: out.error ? "failed" : out.nudged ? "nudged" : "silent",
        why: out.error ?? "",
        ms: Date.now() - t0,
      },
      out.run_id,
    );
    if (kind === "leave") finish(this.d.sql, item.id, out.error ? "failed" : "done", out.run_id);
    else {
      const s = settings.speaking[kind];
      const next = nextRun({ kind: "schedule", at: s.at, days: [] }, new Date(Math.max(Date.now(), item.due_at) + 60_000), tz)!;
      await this.d.clock.schedule(rearm(this.d.sql, item.id, next.getTime())!);
    }
  }

  // --- reactions ------------------------------------------------------------------------------------------

  /** A nudge went out: it's watched for a reaction. */
  sent(n: Nudge): void {
    saveNudges(this.d.sql, [...nudges(this.d.sql), n]);
  }

  /**
   * The owner said something: if a nudge is waiting for a reaction, this is
   * it. "Stop" turns that kind off (Settings → Notifications → Speaking up
   * shows it, and turns it back on). Returns what changed, for the run's note.
   */
  async reacted(text: string, now = Date.now()): Promise<string | null> {
    const all = nudges(this.d.sql);
    // A reply says more than opening the notification did, so it's the reaction that counts.
    const n = [...all]
      .reverse()
      .find((x) => (!x.reaction || x.reaction === "opened" || x.reaction === "dismissed") && now - x.at < REACT_MS);
    if (!n) return null;
    let reaction: Nudge["reaction"] = "replied";
    const decider = this.d.decider();
    if (decider) {
      try {
        const p = await decider.yesNo(
          `Atlas sent the owner, on its own: "${n.text}"\n\nThe owner replied: "${text.slice(0, 600)}"`,
          {
            stop: { instructions: "Is the owner asking Atlas to stop sending messages like this one?" },
            thanks: { instructions: "Is the owner thanking Atlas, or saying the message was useful?" },
          },
          AbortSignal.timeout(3_000),
        );
        reaction = (p.stop ?? 0) >= 0.6 ? "stop" : (p.thanks ?? 0) >= 0.6 ? "thanks" : "replied";
      } catch (err) {
        console.error(JSON.stringify({ at: "awareness.reaction", error: err instanceof Error ? err.message : String(err) }));
      }
    }
    this.#react(n, reaction);
    if (reaction !== "stop") return null;
    const s = readSettings(this.d.sql);
    const speaking = structuredClone(s.speaking);
    if (n.kind === "morning" || n.kind === "evening") speaking[n.kind].on = false;
    else speaking[n.kind] = false;
    writeSettings(this.d.sql, { speaking });
    append(this.d.sql, {
      actor: "owner",
      kind: "settings.change",
      body: { keys: ["speaking"], why: `said stop to ${NUDGE_WORDS[n.kind]}` },
    });
    await this.armRhythm();
    return `The owner just said stop to your nudges about ${NUDGE_WORDS[n.kind]}, so you've turned them off. Say so in a few words, and that Settings → Notifications → Speaking up turns them back on.`;
  }

  /** A push for a nudge was opened or dismissed on a device. */
  pushed(id: string, how: "opened" | "dismissed"): void {
    const n = nudges(this.d.sql).find((x) => x.id === id && (!x.reaction || x.reaction === "ignored"));
    if (n) this.#react(n, how);
  }

  #react(n: Nudge, reaction: NonNullable<Nudge["reaction"]>): void {
    saveNudges(
      this.d.sql,
      nudges(this.d.sql).map((x) => (x.id === n.id ? { ...x, reaction } : x)),
    );
    this.#log({ nudge: n.id, kind: n.kind, reaction, text: n.text.slice(0, 200) });
  }

  #ignored(now: number): void {
    for (const n of nudges(this.d.sql).filter((x) => !x.reaction)) {
      // A push held for quiet hours or focus starts its two hours when it's released, not when Atlas wrote it.
      const held = this.d.sql
        .exec<{ until: number | null }>(
          `SELECT MAX(json_extract(body, '$.held_until')) AS until FROM log WHERE kind = 'delivery' AND json_extract(body, '$.held_until') IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(json_extract(body, '$.of')) WHERE value = ?)`,
          n.id,
        )
        .one().until;
      if (now - Math.max(n.at, held ?? 0) >= IGNORED_MS) this.#react(n, "ignored");
    }
  }
}

/** A sense row in words, for the log and for decide. */
export function describe(row: LogRow): string {
  const b = row.body as {
    event?: string;
    place?: { name?: string };
    stayed_ms?: number;
    near?: { name: string; m: number } | null;
    motion?: string[];
  };
  if (b.event === "arrived") return `The owner arrived at ${b.place?.name ?? "a saved place"}`;
  if (b.event === "left")
    return `The owner left ${b.place?.name ?? "a saved place"}${b.stayed_ms ? ` after ${minutes(b.stayed_ms / 1000)}` : ""}`;
  if (b.event === "moved")
    return `The owner moved${b.near ? `, now about ${Math.round(b.near.m / 100) / 10} km from ${b.near.name}` : ""}${b.motion?.includes("automotive") ? ", driving" : ""}`;
  return `Location turned ${b.event ?? "?"}`;
}

const titleOf = (open: Array<{ id: string; title: string }>, id: string) => open.find((o) => o.id === id)?.title ?? id;

/** How the owner took this kind of nudge lately, for Atlas's note. */
function reactionsLine(sql: Sql, kind: NudgeKind): string {
  const mine = nudges(sql)
    .filter((n) => n.kind === kind && n.reaction)
    .slice(-10);
  if (!mine.length) return "";
  const count = (r: string) => mine.filter((n) => n.reaction === r).length;
  const parts = (["thanks", "replied", "opened", "ignored", "dismissed", "stop"] as const)
    .map((r) => (count(r) ? `${count(r)} ${r}` : ""))
    .filter(Boolean);
  return `How the owner took your last ${mine.length} nudges about ${NUDGE_WORDS[kind]}: ${parts.join(", ")}. Fewer and better if they've been ignored.`;
}

/** What Atlas already said on its own today, so a moment never says it twice. */
function saidToday(sql: Sql, tz: string): string[] {
  const from = startOfLocalDay(new Date(), tz).getTime();
  return sql
    .exec<{ body: string }>(
      `SELECT body FROM log WHERE kind = 'message.out' AND at >= ? AND json_extract(body, '$.nudge') IS NOT NULL ORDER BY seq LIMIT 20`,
      from,
    )
    .toArray()
    .map((r) =>
      String(parse<{ text?: string }>(r.body, {}).text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 200),
    );
}

/** The Speaking up line for every prompt: what Atlas may bring up on its own. */
export function speakingLine(s: Settings): string {
  const on = (Object.keys(NUDGE_WORDS) as NudgeKind[]).filter((k) => isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  const off = (Object.keys(NUDGE_WORDS) as NudgeKind[]).filter((k) => !isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  return `Speaking up on your own (Settings → Notifications → Speaking up): ${on.length ? `on for ${on.join(", ")}` : "off for everything"}${on.length && off.length ? `; off for ${off.join(", ")}` : ""}.`;
}

/**
 * The way a run of Atlas's own speaks up (§10.3): one short message to the
 * owner, through the outbox like every message, as something that can wait
 * (quiet hours, focus and the day's budget apply). No nudge is silence.
 */
export function nudgeTool(send: (text: string) => Promise<{ ok: boolean; text: string }>): Tool {
  return defineTool({
    name: "nudge",
    kind: "look",
    description: [
      "Tell the owner something now, on your own: in the app if it's open, else a notification on their phone, or out loud in a call.",
      "Use it at most once, only when hearing it now would help them, in a sentence or two, the way you'd text a friend. Not using it is silence, which is right more often than not.",
    ].join(" "),
    input: z.object({ text: z.string().min(1).max(600) }),
    async run(input) {
      const out = await send(input.text);
      return out.ok ? { ok: true, output: { sent: true, how: out.text } } : fail(out.text);
    },
  });
}
