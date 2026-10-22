// Awareness without the cost (VISION §10.3). Everything a sense notices goes
// through three steps: rules (cheap and fixed), then `decide` (Clef: would
// this be worth a thought now, and does it matter to anything open?), then a
// run of Atlas's own, only when it might, which works out what would help
// and speaks up with `nudge`, does what's its to do, or stays silent. What
// it notices is a move or a place, a device's event, and what changed when
// the situation was looked at again: the calendar ahead, the trip to the
// next event, the weather. Rhythm moments (start of day, evening, a look
// before leaving for an event) are agenda items on the one clock and go
// straight to Atlas, who may also stay silent. Each step leaves an
// `awareness` row, so History says what was decided and why, and the
// owner's reactions to nudges are logged with what each was about. This
// desk also keeps the situation's cache current (core/src/situation.ts).
// None of it says what to tell the owner: the character and the situation
// do (rule 1).

import { type Decider } from "../brains/decide";
import type { Calendar } from "../calendar/types";
import { nextRun } from "../automations";
import { kindWords } from "../maps";
import { type AgendaItem, createItem, finish, getItem, rearm, upcoming } from "../store/agenda";
import { parse, type Sql } from "../store/db";
import { append, type LogRow } from "../store/log";
import { findRecords } from "../store/records";
import { readSettings, type Settings, writeSettings } from "../store/settings";
import { getState, setState } from "../store/state";
import { cache, changes, placeOf, refresh as refreshCache, situationLines, TRAVEL_AHEAD_MS } from "../situation";
import { clockLocal, shortLocal, startOfLocalDay, zoneOf } from "../time";
import { minutes } from "../maps";
import { z } from "zod";
import { defineTool, fail, type MapsApi, type Tool, type ToolContext } from "../tools/types";

/** What started a nudge; each has a switch in Settings → Notifications → Speaking up. */
export type NudgeFrom = "noticing" | "leave" | "morning" | "evening";

export const NUDGE_WORDS: Record<NudgeFrom, string> = {
  noticing: "what Atlas notices",
  leave: "when to leave for events",
  morning: "the start of day",
  evening: "the evening",
};

/** A nudge Atlas sent, and how the owner took it. */
export interface Nudge {
  /** The message's log row. */
  id: string;
  from: NudgeFrom;
  /** What it was about, in Atlas's words ("oat milk on the way home"). */
  about: string;
  /** The errand or other thing it was about, when there was one. */
  ref?: string;
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
/** The same event (at the same place, from the same device) within this long is a duplicate; a change to the situation, within six hours. */
const DUPLICATE_MS = 10 * 60_000;
const SAME_CHANGE_MS = 6 * 3_600_000;
/** On the move, the most often a move wakes Atlas. */
export const MOVE_COOLDOWN_MS = 20 * 60_000;
/** The leave look comes this long before the leave-by time. */
export const LEAVE_LEAD_MS = 10 * 60_000;
/** The owner counts as using Atlas when they've said something this recently: the weather and travel are kept current then. */
const ACTIVE_MS = 2 * 3_600_000;

export const nudges = (sql: Sql): Nudge[] =>
  // Nudges kept before they had `from` read as noticed ones.
  (getState<Nudge[]>(sql, "nudges") ?? []).map((n) => ({ ...n, from: n.from ?? "noticing", about: n.about ?? "" }));
const saveNudges = (sql: Sql, all: Nudge[]) => setState(sql, "nudges", all.slice(-40));

export function isOn(s: Settings, k: NudgeFrom): boolean {
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
  wake(o: { trigger: string; note: string; from: NudgeFrom; ref?: string }): Promise<{ run_id: string; nudged: boolean; error?: string }>;
  rows(rows: LogRow[]): void;
  /** Keeps the agent alive while this runs in the background. */
  background(fn: () => Promise<void>): void;
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
        const before = cache(this.d.sql);
        const after = await refreshCache({
          sql: this.d.sql,
          settings,
          calendar: this.d.calendar(),
          maps: this.d.maps(),
          full: full && this.#needed(settings),
        });
        await this.#armLeave(settings);
        // What changed is news for the senses, like a move: the calendar ahead, the trip, the weather.
        const noticed = changes(before, after, settings).map((body) =>
          append(this.d.sql, { actor: "system", kind: "sense", body: body as never }),
        );
        if (noticed.length) {
          this.d.rows(noticed);
          // Not awaited: a run that's waiting for this refresh (an owner's turn) would hold up the wake's own turn.
          this.d.background(() => this.sensed(noticed));
        }
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
      // Location turned on or off is the owner's own doing, not news.
      if (row.body.source !== "node" && row.body.source !== "situation" && !["arrived", "left", "moved"].includes(String(row.body.event)))
        continue;
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
    if (!isOn(settings, "noticing")) {
      quiet("rules", "Speaking up about what Atlas notices is off.");
      return;
    }
    // The same news twice in a short while (the edge of a place, a device flickering, a forecast that came back) isn't news.
    const key = subjectOf(row);
    if (key) {
      const since = row.at - (row.body.source === "situation" ? SAME_CHANGE_MS : DUPLICATE_MS);
      const dup = this.d.sql
        .exec<{ body: string }>(
          `SELECT body FROM log WHERE kind = 'sense' AND seq < ? AND at > ? ORDER BY seq DESC LIMIT 200`,
          row.seq,
          since,
        )
        .toArray()
        .some((r) => subjectOf({ body: parse<Record<string, unknown>>(r.body, {}) }) === key);
      if (dup) {
        quiet("rules", "The same happened a little while ago.");
        return;
      }
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

    // 2. Decide: is it worth a thought now, and does it matter to anything open?
    const decider = this.d.decider();
    let matched = open;
    let worth = true;
    let scores: Record<string, number> | null = null;
    let why = "";
    if (decider) {
      const state = `${event}\n\n${situationLines(this.d.sql, settings)}`;
      const questions = {
        [NOW]: { instructions: worthQuestion(settings) },
        ...Object.fromEntries(open.slice(0, 30).map((o) => [o.id, { instructions: o.question }])),
      };
      try {
        scores = await decider.yesNo(state.slice(0, 4_000), questions, AbortSignal.timeout(8_000));
        matched = open.filter((o) => (scores![o.id] ?? 0) >= MATTERS);
        worth = (scores[NOW] ?? 0) >= MATTERS;
      } catch (err) {
        why = `decide didn't answer (${err instanceof Error ? err.message : String(err)}), so Atlas looked itself`;
      }
    } else if (open.length) {
      why = "there's no decide role here, so Atlas looked itself";
    } else {
      // Without decide, the main brain would look at every move; it looks only when something is open.
      worth = false;
    }
    const top = scores
      ? Object.fromEntries(
          Object.entries(scores).map(([k, v]) => [k === NOW ? "worth a thought" : titleOf(open, k), Math.round(v * 100) / 100]),
        )
      : undefined;
    if (!matched.length && !worth) {
      quiet(
        "decide",
        decider ? "It isn't worth a thought now, and doesn't matter to anything open." : "There's no decide role, and nothing is open.",
        top ? { scores: top } : {},
      );
      return;
    }
    if (!scores) matched = open;

    // 3. Atlas, only now, with the event and what it may matter to. What to make of it is Atlas's own judgment.
    const note = [
      `[Atlas's senses, not the owner] ${event}.`,
      matched.length ? `It may matter to: ${matched.map((m) => m.text).join("; ")}.` : "",
      AWARE,
      quietLine(settings),
      reactionsLine(this.d.sql),
    ]
      .filter(Boolean)
      .join("\n\n");
    const ref = matched.find((m) => m.kind === "errand");
    const out = await this.d.wake({ trigger: `sense:${row.id}`, note, from: "noticing", ...(ref ? { ref: ref.id } : {}) });
    this.#log(
      {
        of: row.id,
        event,
        step: "woke",
        outcome: out.error ? "failed" : out.nudged ? "nudged" : "silent",
        why:
          out.error ??
          (why || (matched.length ? `It may matter to ${matched.map((m) => m.title).join(", ")}.` : "It seemed worth a thought.")),
        ms: Date.now() - t0,
        ...(top ? { scores: top } : {}),
      },
      out.run_id,
    );
  }

  /** What an event could matter to: open errands, and commitments, reminders and promises coming up. */
  #openThings(
    settings: Settings,
  ): Array<{ id: string; kind: "errand" | "agenda" | "commitment"; title: string; text: string; question: string }> {
    const out: Array<{ id: string; kind: "errand" | "agenda" | "commitment"; title: string; text: string; question: string }> = [];
    {
      for (const e of upcoming(this.d.sql, 200)
        .filter((i) => i.kind === "errand" && i.state === "scheduled")
        .slice(0, 20)) {
        const where = errandWhere(e);
        out.push({
          id: e.id,
          kind: "errand",
          title: e.title,
          text: `the errand "${e.title}"${where ? ` (at ${where})` : ""} (id ${e.id})`,
          question: `The owner has an open errand: "${e.title}"${where ? `, done at ${where}` : ""}. Given this event and where they are and seem to be heading, could now be a good moment to get it done, or to suggest it?`,
        });
      }
    }
    {
      const soon = Date.now() + 86_400_000;
      for (const i of upcoming(this.d.sql, 100)
        .filter((x) => (x.kind === "reminder" || x.kind === "promise") && x.state === "scheduled" && x.due_at < soon)
        .slice(0, 5)) {
        out.push({
          id: i.id,
          kind: "agenda",
          title: i.title,
          text: `the ${i.kind} "${i.title}" (due ${shortLocal(new Date(i.due_at), zoneOf(settings))})`,
          question: `The owner has a ${i.kind} coming up: "${i.title}". Does this event change anything about it, or make now the moment for it?`,
        });
      }
      for (const r of findRecords(this.d.sql, "commitment").slice(0, 5)) {
        out.push({
          id: r.id,
          kind: "commitment",
          title: r.name,
          text: `the commitment "${r.name}"`,
          question: `The owner has a commitment: "${r.name}"${typeof r.fields.fact === "string" ? ` (${r.fields.fact})` : ""}. Does this event matter to it?`,
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
    const kind: NudgeFrom = moment === "leave" ? "leave" : moment === "evening" ? "evening" : "morning";
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
        "If they're already there or on their way (see the situation), or it clearly doesn't need them to go, don't nudge. Otherwise nudge once, short: when to leave and how long it takes, and anything else that would help on the way (traffic, the weather, something to bring or pick up).",
        quietLine(settings),
        reactionsLine(this.d.sql),
      ]
        .filter(Boolean)
        .join("\n\n");
    } else {
      note = [
        `[Atlas's clock, not the owner] It's the ${kind === "morning" ? "start of the day" : "evening"}: your look at ${kind === "morning" ? "the day ahead" : "how today went and what tomorrow holds"}, which may end in silence.`,
        `Look it over the way a great assistant would: the situation, the calendar, reminders, errands, the people involved and what you know of them, and the weather. Think about what they'd be glad to hear now, or what you could get ready for them. If there's something, nudge once with it, in a few lines; if there isn't, don't nudge.`,
        said.length ? `You've already said today (never say it again):\n${said.map((s) => `- ${s}`).join("\n")}` : "",
        quietLine(settings),
        reactionsLine(this.d.sql),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const out = await this.d.wake({ trigger: `rhythm:${item.id}`, note, from: kind });
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
   * it. On "stop", Atlas is told, and decides with `speaking_up` what the
   * owner meant to stop: that one subject, or a whole moment. Returns the
   * note for the run, if any.
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
    const moment = n.from === "noticing" ? "" : ` It came from ${NUDGE_WORDS[n.from]}, which has its own switch.`;
    return `The owner seems to be saying stop to the nudge you sent: "${n.text.slice(0, 200)}"${n.about ? ` (about ${n.about})` : ""}.${moment} Work out what they want to stop, as narrow or as broad as they meant it, and change it with speaking_up; ask only if you truly can't tell. Then say what you changed in a few words.`;
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
    this.#log({ nudge: n.id, from: n.from, about: n.about, reaction, text: n.text.slice(0, 200) });
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
export function describe(row: Pick<LogRow, "body">): string {
  const b = row.body as {
    source?: string;
    event?: string;
    what?: string;
    node?: { name?: string };
    body?: unknown;
    place?: { name?: string };
    stayed_ms?: number;
    near?: { name: string; m: number } | null;
    motion?: string[];
  };
  if (b.source === "situation") return String(b.what ?? "The situation changed");
  if (b.source === "node") {
    const device = b.node?.name ?? "A paired device";
    if (b.event === "online") return `${device} came online`;
    if (b.event === "offline") return `${device} went offline`;
    return `${device} says ${String(b.event ?? "something").replace(/_/g, " ")}: ${JSON.stringify(b.body ?? {}).slice(0, 300)}`;
  }
  if (b.event === "arrived") return `The owner arrived at ${b.place?.name ?? "a saved place"}`;
  if (b.event === "left")
    return `The owner left ${b.place?.name ?? "a saved place"}${b.stayed_ms ? ` after ${minutes(b.stayed_ms / 1000)}` : ""}`;
  if (b.event === "moved")
    return `The owner moved${b.near ? `, now about ${Math.round(b.near.m / 100) / 10} km from ${b.near.name}` : ""}${b.motion?.includes("automotive") ? ", driving" : ""}`;
  return `Location turned ${b.event ?? "?"}`;
}

const titleOf = (open: Array<{ id: string; title: string }>, id: string) => open.find((o) => o.id === id)?.title ?? id;

/** Decide's own question for every event: is it worth a thought now, whatever is open? */
const NOW = "worth_a_thought";

/** What makes the same news twice: the event and its place, its device and what it said, or the change's own key. */
function subjectOf(row: { body: Record<string, unknown> }): string | null {
  const b = row.body as { source?: string; event?: string; key?: string; place?: { id?: string }; node?: { id?: string }; body?: unknown };
  if (b.source === "situation") return b.key ? `situation:${b.key}` : null;
  if (b.source === "node") return `node:${b.node?.id ?? ""}:${b.event ?? ""}:${JSON.stringify(b.body ?? {})}`;
  if (b.event === "moved") return null;
  return b.place?.id ? `${b.event}:${b.place.id}` : null;
}

function worthQuestion(s: Settings): string {
  return [
    "Something just happened around the owner (above, with their situation).",
    "Would a thoughtful personal assistant who knows them well want to think about it right now, because it could change their plans or timing, help with something they need or care about, or matter to their safety or money?",
    "Ordinary comings and goings that change nothing are a no.",
    s.speaking.quiet_about.length
      ? `They asked not to hear about: ${s.speaking.quiet_about.join("; ")}; something only about those is a no.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What a run woken by a sense is asked to do: think, and speak only if it helps. The judgment is Atlas's own. */
const AWARE = [
  "This is your chance to be useful without being asked. Think about what it means for the owner right now, given the situation, their calendar, errands, reminders and people, and what you know of them, and connect the dots they'd want connected.",
  "Look things up if that would help (a route, a place on their way, the weather, their calendar), and do what's yours to do. If telling them now would help, nudge once, in a sentence or two, the way you'd text a friend.",
  "If it wouldn't (it changes nothing for them, it can wait, you'd be guessing, they're busy), don't nudge: end with a few words for your own log saying why. Silence is often right.",
].join(" ");

/** What the owner doesn't want to hear about, for Atlas's note. */
function quietLine(s: Settings): string {
  return s.speaking.quiet_about.length
    ? `The owner asked you not to bring up: ${s.speaking.quiet_about.join("; ")} (Settings → Notifications → Speaking up).`
    : "";
}

/** An errand's kind of place or particular place, in words. */
function errandWhere(e: AgendaItem): string {
  const k = e.source.detail?.place_kind;
  if (typeof k === "string") return kindWords(k);
  return typeof e.source.detail?.place === "string" ? e.source.detail.place : "";
}

/** The last nudges and how the owner took each, for Atlas's note, so it learns what's welcome. */
function reactionsLine(sql: Sql): string {
  const mine = nudges(sql)
    .filter((n) => n.reaction)
    .slice(-8);
  if (!mine.length) return "";
  return `Your last nudges and how the owner took them: ${mine.map((n) => `"${(n.about || n.text).slice(0, 80)}" (${n.reaction})`).join("; ")}. Say fewer, better things if they've been ignored or dismissed.`;
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

/** The Speaking up line for every prompt: what Atlas may bring up on its own, and what the owner asked it not to. */
export function speakingLine(s: Settings): string {
  const on = (Object.keys(NUDGE_WORDS) as NudgeFrom[]).filter((k) => isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  const off = (Object.keys(NUDGE_WORDS) as NudgeFrom[]).filter((k) => !isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  return [
    `Speaking up on your own (Settings → Notifications → Speaking up; change it with speaking_up): ${on.length ? `on for ${on.join(", ")}` : "off for everything"}${on.length && off.length ? `; off for ${off.join(", ")}` : ""}.`,
    s.speaking.quiet_about.length ? ` The owner asked you not to bring up: ${s.speaking.quiet_about.join("; ")}.` : "",
  ].join("");
}

/**
 * The way a run of Atlas's own speaks up (§10.3): one short message to the
 * owner, through the outbox like every message, as something that can wait
 * (quiet hours, focus and the day's budget apply). No nudge is silence.
 */
export function nudgeTool(send: (text: string, about: string) => Promise<{ ok: boolean; text: string }>): Tool {
  return defineTool({
    name: "nudge",
    kind: "look",
    description: [
      "Tell the owner something now, on your own: in the app if it's open, else a notification on their phone, or out loud in a call.",
      "Use it at most once, only when hearing it now would help them, in a sentence or two, the way you'd text a friend. Not using it is silence, which is often right.",
      "`about` names what it's about in a few words ('oat milk on the way home', 'traffic to the dentist'), so you can see later how this kind of thing landed.",
    ].join(" "),
    input: z.object({ text: z.string().min(1).max(600), about: z.string().min(1).max(80) }),
    async run(input) {
      const out = await send(input.text, input.about);
      return out.ok ? { ok: true, output: { sent: true, how: out.text } } : fail(out.text);
    },
  });
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 07:30");

/**
 * The owner's Speaking up, changed by Atlas when they ask ("stop telling me
 * about the weather", "do the morning look at seven"). It's their own
 * setting, so Atlas just does it, with a receipt and Undo (§12.1).
 */
export const speakingUp = defineTool({
  name: "speaking_up",
  kind: "change_own",
  description: [
    "Change what you bring up on your own, when the owner asks: add or remove subjects they don't want to hear about (in their words, as narrow or broad as they meant: 'the weather unless it's severe', 'errands'), or switch what you notice, the look before leaving for events, and the start of day and evening looks (with their times).",
    "They see a receipt with Undo, and it all shows in Settings → Notifications → Speaking up.",
  ].join(" "),
  input: z.object({
    quiet_about_add: z.array(z.string().min(1).max(120)).max(5).optional(),
    quiet_about_remove: z.array(z.string().min(1).max(120)).max(5).optional(),
    noticing: z.boolean().optional().describe("Whether you speak up about what your senses notice."),
    leave: z.boolean().optional().describe("Whether you look before they leave for an event with a place."),
    morning: z.object({ on: z.boolean().optional(), at: HHMM.optional() }).optional(),
    evening: z.object({ on: z.boolean().optional(), at: HHMM.optional() }).optional(),
  }),
  async run(input, ctx) {
    const before = readSettings(ctx.sql).speaking;
    const lower = (x: string) => x.trim().toLowerCase();
    const drop = new Set((input.quiet_about_remove ?? []).map(lower));
    const quiet = [...before.quiet_about.filter((q) => !drop.has(lower(q)))];
    for (const q of input.quiet_about_add ?? []) if (!quiet.some((x) => lower(x) === lower(q))) quiet.push(q.trim());
    const after: Settings["speaking"] = {
      noticing: input.noticing ?? before.noticing,
      leave: input.leave ?? before.leave,
      morning: { ...before.morning, ...input.morning },
      evening: { ...before.evening, ...input.evening },
      quiet_about: quiet.slice(-30),
    };
    if (JSON.stringify(after) === JSON.stringify(before)) return { ok: true, output: { changed: false, speaking: before } };
    writeSettings(ctx.sql, { speaking: after });
    append(ctx.sql, { actor: "atlas", kind: "settings.change", run_id: ctx.run_id, body: { keys: ["speaking"], why: "asked in chat" } });
    await ctx.speaking?.();
    const said = [
      ...(input.quiet_about_add ?? []).map((q) => `won't bring up ${q}`),
      ...(input.quiet_about_remove ?? []).map((q) => `may bring up ${q} again`),
      ...(["noticing", "leave"] as const).filter((k) => input[k] != null).map((k) => `${NUDGE_WORDS[k]} ${input[k] ? "on" : "off"}`),
      ...(["morning", "evening"] as const)
        .filter((k) => input[k])
        .map((k) => `${NUDGE_WORDS[k]} ${after[k].on ? `on at ${after[k].at}` : "off"}`),
    ];
    return {
      ok: true,
      output: { changed: true, speaking: after },
      receipt: { text: `Speaking up · ${said.join(", ") || "changed"}`, undo: { kind: "speaking.restore", before } },
    };
  },
});
