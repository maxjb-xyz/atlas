// Awareness without the cost (VISION §10.3), for everything the intake
// takes in (§10.4, core/src/intake.ts). Each item is weighed: cheap fixed
// rules, then `decide` (Clef: worth a thought now, worth knowing later, or
// not at all, and does it matter to anything open?). Now wakes a run of
// Atlas's own, which works out what would help and speaks up with `nudge`,
// does what's its to do, or stays silent. Later goes on the later pile,
// which a run of Atlas's own looks over in a batch on the clock, as do the
// routines that look at the day, and which the owner's next turn sees.
// The moment before each event (with who it's with, and the trip to it)
// is an agenda item on the one clock that becomes an item for the intake,
// so a task for a person meets the meeting with them. Each step leaves an
// `awareness` row, so History says what was decided and why; each item's
// place is kept in the intake, so a restart picks up where it stopped.
// The owner's reactions to nudges are logged with what each was about.
// This desk also keeps the situation's cache current (core/src/situation.ts)
// and looks at the calendar for changes. None of it says what to tell the
// owner: the character and the situation do (rule 1).

import { type Decider } from "../brains/decide";
import { personText, type Calendar } from "../calendar/types";
import { fitsOf, fitsText, openTasks, personIn } from "../tasks";
import { type AgendaItem, createItem, finish, rearm, upcoming } from "../store/agenda";
import { parse, type Sql } from "../store/db";
import { append, type LogRow } from "../store/log";
import { calendarLook, describe, laterPile, mark, markSeen, take as collect, unfinished, type IntakeItem, type SenseItem } from "../intake";
import { findRecords } from "../store/records";
import { readSettings, type Settings, writeSettings } from "../store/settings";
import { getState, setState } from "../store/state";
import {
  cache,
  changes,
  placeOf,
  refresh as refreshCache,
  type SituationEvent,
  situationLines,
  TRAVEL_AHEAD_MS,
  withText,
} from "../situation";
import { clockLocal, shortLocal, startOfLocalDay, zoneOf } from "../time";
import { minutes } from "../maps";
import { z } from "zod";
import { defineTool, fail, type MapsApi, type Tool, type ToolContext } from "../tools/types";

/** What started a nudge; each has a switch in Settings → Notifications → Speaking up. */
export type NudgeFrom = "noticing" | "leave" | "routine";

/** The switches in Speaking up. A routine's report has its own place: its automation (§13.4). */
export const NUDGE_WORDS: Record<"noticing" | "leave", string> = {
  noticing: "what Atlas notices",
  leave: "when to leave for events",
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
/** What an item may matter to: a task at a place (always looked at for a location item), another task, the agenda, a commitment or goal. */
type OpenKind = "place" | "task" | "agenda" | "commitment";
/** Something open an item could matter to, with the question decide is asked about it (none for a place task). */
type OpenThing = { id: string; kind: OpenKind; title: string; text: string; question: string; place?: string; person?: string };

/** How sure `decide` must be that an event matters before Atlas wakes. */
export const MATTERS = 0.5;
/** The later pile is looked over when its oldest has waited this long, or it has this many, and at most this often. */
export const REVIEW_AFTER_MS = 60 * 60_000;
const REVIEW_COUNT = 8;
/** On the move, the most often a move wakes Atlas. */
export const MOVE_COOLDOWN_MS = 20 * 60_000;
/** The moment before an event with a trip comes this long before leave-by. */
export const LEAVE_LEAD_MS = 10 * 60_000;
/** An event's moment comes this long before it starts (or before leave-by, when there's a trip). */
export const SOON_MS = 10 * 60_000;
/** The owner counts as using Atlas when they've said something this recently: the weather and travel are kept current then. */
const ACTIVE_MS = 2 * 3_600_000;

export const nudges = (sql: Sql): Nudge[] =>
  // Nudges kept before they had `from` read as noticed ones.
  (getState<Nudge[]>(sql, "nudges") ?? []).map((n) => ({ ...n, from: n.from ?? "noticing", about: n.about ?? "" }));
const saveNudges = (sql: Sql, all: Nudge[]) => setState(sql, "nudges", all.slice(-40));

export function isOn(s: Settings, k: keyof typeof NUDGE_WORDS): boolean {
  return s.speaking[k];
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
  /** Automations whose triggers read the intake (a calendar change) see what came in. */
  automations(rows: LogRow[]): Promise<void>;
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
        await this.#armSoon(settings);
        // What changed is news for the senses, like a move: the trip to the next event, the weather.
        this.take(changes(before, after, settings));
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
    const at = now + this.#every(now);
    if (open && open.state === "scheduled" && open.due_at <= at) return;
    const item = open
      ? rearm(this.d.sql, open.id, at)!
      : createItem(this.d.sql, { kind: "situation", title: "Keep the situation current", due_at: at, source: { via: "senses" } });
    await this.d.clock.schedule(item);
  }

  /** Every 15 minutes while the weather and trip are needed, else every half hour, for the calendar's changes. */
  #every(now: number): number {
    return this.#needed(readSettings(this.d.sql), now) ? 15 * 60_000 : 30 * 60_000;
  }

  /**
   * The clock's tick (the item is already leased): the calendar's changes,
   * the situation, ignored nudges, the later pile when it's due a look,
   * and back on the clock.
   */
  async tick(item: AgendaItem): Promise<void> {
    const now = Date.now();
    try {
      const cal = this.d.calendar();
      if (cal) this.take(await calendarLook(this.d.sql, cal, readSettings(this.d.sql), now));
      await this.refresh(true);
      this.#ignored(now);
      await this.#review(now);
    } finally {
      await this.d.clock.schedule(rearm(this.d.sql, item.id, now + this.#every(now))!);
    }
  }

  /**
   * Collect (§10.4): items from any source become sense rows in the intake.
   * Automations that read the intake see them, and each new one is weighed,
   * in the background, so the source isn't kept waiting and a run waiting
   * on this one (an owner's turn) doesn't hold up a wake.
   */
  take(items: Array<Omit<SenseItem, "what"> & { what?: string }>, o: { raw?: string; refresh?: boolean } = {}): LogRow[] {
    if (!items.length) return [];
    const { rows, fresh } = collect(this.d.sql, items, o.raw ? { raw: o.raw } : {});
    this.d.rows(rows);
    this.d.background(async () => {
      // A move changes the situation, so it's brought up to date before the move is weighed.
      if (o.refresh) await this.refresh(true);
      await this.d
        .automations(fresh)
        .catch((err: unknown) =>
          console.error(JSON.stringify({ at: "intake.automations", error: err instanceof Error ? err.message : String(err) })),
        );
      await this.sensed(fresh);
    });
    return rows;
  }

  /**
   * An owner's turn that saw the later pile (its newest, in "noticed since
   * your last look") and replied: those are looked at, so the batch look
   * doesn't tell the owner again what this turn may have told them.
   */
  seenBy(before: number): void {
    markSeen(
      this.d.sql,
      laterPile(this.d.sql, PILE_SHOWN)
        .filter((i) => i.at < before)
        .map((i) => i.id),
    );
  }

  /** After a restart: items left half way are weighed again. */
  async resume(): Promise<void> {
    const left = unfinished(this.d.sql);
    if (left.length) await this.sensed(left);
  }

  // --- step by step, for each sense event ---------------------------------------------------------------

  /** Weighs what the intake took in, one at a time. Never throws: a failure is logged with its words, and the item marked failed. */
  async sensed(rows: LogRow[]): Promise<void> {
    for (const row of rows) {
      try {
        await this.#consider(row);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        mark(this.d.sql, row.id, { state: "failed", why });
        this.#log({ of: row.id, event: describe(row), step: "rules", outcome: "failed", why });
      }
    }
  }

  async #consider(row: LogRow): Promise<void> {
    const t0 = Date.now();
    const settings = readSettings(this.d.sql);
    const event = describe(row);
    const settle = (outcome: "later" | "never", step: "rules" | "decide", why: string, scores?: Record<string, number>) => {
      mark(this.d.sql, row.id, { state: outcome === "never" ? "done" : "weighed", outcome, why, scores: scores ?? null });
      this.#log({
        of: row.id,
        event,
        step,
        outcome: outcome === "later" ? "later" : step === "rules" ? "quiet" : "not relevant",
        why,
        ms: Date.now() - t0,
        ...(scores ? { scores } : {}),
      });
    };

    // 1. Rules: cheap and fixed. Duplicates were already set aside when the item came in.
    const b = row.body as SenseItem & { place?: { name?: string }; leave_by?: number };
    // An event coming up (§10.3): with a trip, it's nearly time to leave, which is always a look while that switch is on.
    const soon = b.source === "calendar" && b.event === "soon";
    const leaving = soon && typeof b.leave_by === "number" && isOn(settings, "leave");
    const noticing = isOn(settings, "noticing");
    if (!noticing && !leaving) {
      settle("never", "rules", "Speaking up about what Atlas notices is off.");
      return;
    }
    const all = noticing ? this.#openThings(settings) : [];
    // A task that fits at a place is about where the owner is: leaving a place or moving is always worth a look for
    // it, and so is arriving at the task's own place (a rule, since decide scored leaving the gym with one open either
    // side of any bar). Nothing else asks about it.
    const here = b.event === "arrived" ? (b.place?.name ?? "").toLowerCase() : "";
    const placed =
      b.source !== "location"
        ? []
        : all.filter((o) => o.kind === "place" && (b.event === "left" || b.event === "moved" || (here && o.place?.toLowerCase() === here)));
    // A task for a person is about whoever an item is from or with: when that's someone Atlas knows as them (by a
    // name or an address), it matters, with no score in the way. Anyone else is for decide to judge.
    const who = [b.from, ...(Array.isArray(b.people) ? b.people : [])].filter((x): x is string => typeof x === "string" && !!x);
    const personal = who.length ? all.filter((o) => o.kind === "task" && o.person && personIn(this.d.sql, o.person, who)) : [];
    const open = all.filter((o) => o.kind !== "place" && !personal.includes(o));

    // 2. Decide: now, later or never, and does it matter to anything open? An event coming up is something the
    // owner's calendar already tells them, so for it decide is only asked what's open that it touches.
    const decider = noticing ? this.d.decider() : null;
    let matched = noticing && !(soon && decider) ? open : [];
    let now = noticing && !soon;
    let later = !soon;
    let scores: Record<string, number> | null = null;
    let why = "";
    if (decider && (!soon || open.length)) {
      const state = `${event}\n\n${situationLines(this.d.sql, settings)}`;
      const questions = {
        ...(soon ? {} : { [NOW]: { instructions: nowQuestion(settings) }, [LATER]: { instructions: laterQuestion(settings) } }),
        ...Object.fromEntries(open.slice(0, 30).map((o) => [o.id, { instructions: o.question }])),
      };
      try {
        scores = await decider.yesNo(state.slice(0, 4_000), questions, AbortSignal.timeout(8_000));
        matched = open.filter((o) => (scores![o.id] ?? 0) >= MATTERS);
        now = (!soon && (scores[NOW] ?? 0) >= MATTERS) || matched.length > 0;
        later = !soon && (scores[LATER] ?? 0) >= MATTERS;
      } catch (err) {
        why = `decide didn't answer (${err instanceof Error ? err.message : String(err)})`;
        matched = open;
        now = open.length > 0;
      }
    } else if (noticing && !decider) {
      // Without decide, the main brain looks now only when something is open; the rest waits for the batch.
      why = "there's no decide role here";
      now = open.length > 0;
    }
    if (placed.length) {
      matched = [...placed, ...matched];
      now = true;
      const fits = `where the owner is changed, and ${placed.length === 1 ? "a task fits" : "tasks fit"} at a place: ${placed.map((o) => o.title).join(", ")}`;
      why = why ? `${why}; ${fits}.` : `${fits[0]!.toUpperCase()}${fits.slice(1)}.`;
    }
    if (personal.length) {
      matched = [...personal, ...matched];
      now = true;
      const fits = `it's from or with someone ${personal.length === 1 ? "a task is" : "tasks are"} for: ${personal.map((o) => `${o.title} (${o.person})`).join(", ")}`;
      why = why ? `${why}; ${fits}.` : `${fits[0]!.toUpperCase()}${fits.slice(1)}.`;
    }
    if (leaving) {
      now = true;
      why = why ? `${why}; it's nearly time to leave.` : "It's nearly time to leave.";
    }
    const top = scores
      ? Object.fromEntries(
          Object.entries(scores).map(([k, v]) => [
            k === NOW ? "worth a thought now" : k === LATER ? "worth knowing later" : titleOf(open, k),
            Math.round(v * 100) / 100,
          ]),
        )
      : undefined;
    // On the move, Atlas looks at most every twenty minutes; leaving a place always counts, since that's the moment.
    if (now && row.body.event === "moved") {
      const looked = this.d.sql
        .exec(
          `SELECT 1 FROM log WHERE kind = 'awareness' AND json_extract(body, '$.step') = 'woke' AND at > ? LIMIT 1`,
          row.at - MOVE_COOLDOWN_MS,
        )
        .toArray().length;
      if (looked) {
        settle(
          "later",
          "rules",
          "Atlas looked a few minutes ago; on the move it looks at most every twenty minutes, so this waits for the next look.",
          top,
        );
        return;
      }
    }
    if (!now && soon) {
      settle(
        "never",
        scores ? "decide" : "rules",
        "Nothing open touches it, and the owner's calendar already tells them it's coming.",
        top,
      );
      return;
    }
    if (!now) {
      if (later || !scores)
        settle("later", "decide", why ? `${why}, so it waits for the next look.` : "It can wait for the next look.", top);
      else settle("never", "decide", "It isn't worth a thought, now or later, and doesn't matter to anything open.", top);
      return;
    }
    mark(this.d.sql, row.id, { state: "weighed", outcome: "now", why: why || "It's worth a thought now.", scores: top ?? null });

    // 3. Atlas, only now, with the event and what it may matter to. What to make of it is Atlas's own judgment.
    const note = [
      `[Atlas's senses, not the owner] ${event}.`,
      matched.length ? `It may matter to: ${matched.map((m) => m.text).join("; ")}.` : "",
      leaving
        ? "It's nearly time to leave for it. If they're already there or on their way (see the situation), or it clearly doesn't need them to go, don't nudge about leaving. Otherwise say when to leave and how long it takes, and anything else that would help on the way (traffic, the weather, something to bring or pick up)."
        : "",
      AWARE,
      listsLine(settings),
      reactionsLine(this.d.sql),
    ]
      .filter(Boolean)
      .join("\n\n");
    const ref = matched.find((m) => m.kind === "place" || m.kind === "task");
    const out = await this.d.wake({
      trigger: `sense:${row.id}`,
      note,
      from: leaving ? "leave" : "noticing",
      ...(ref ? { ref: ref.id } : {}),
    });
    mark(this.d.sql, row.id, { state: out.error ? "failed" : "done", run_id: out.run_id, ...(out.error ? { why: out.error } : {}) });
    this.#log(
      {
        of: row.id,
        event,
        step: "woke",
        outcome: out.error ? "failed" : out.nudged ? "nudged" : "silent",
        why:
          out.error ??
          (why || (matched.length ? `It may matter to ${matched.map((m) => m.title).join(", ")}.` : "It seemed worth a thought now.")),
        ms: Date.now() - t0,
        ...(top ? { scores: top } : {}),
      },
      out.run_id,
    );
  }

  /**
   * The later pile's look (§10.4): a run of Atlas's own over what could
   * wait, as one batch with the full picture, when the oldest has waited an
   * hour or the pile has grown, and at most once an hour.
   */
  async #review(now = Date.now()): Promise<void> {
    const pile = laterPile(this.d.sql, 30);
    if (!pile.length) return;
    const oldest = Math.min(...pile.map((i) => i.at));
    if (now - oldest < REVIEW_AFTER_MS && pile.length < REVIEW_COUNT) return;
    const last = this.d.sql
      .exec(
        `SELECT 1 FROM log WHERE kind = 'awareness' AND json_extract(body, '$.step') = 'review' AND at > ? LIMIT 1`,
        now - REVIEW_AFTER_MS,
      )
      .toArray().length;
    if (last) return;
    const settings = readSettings(this.d.sql);
    const t0 = Date.now();
    const note = [
      `[Atlas's senses, not the owner] Since your last look, these came in and decide thought they could wait:\n${pileList(pile, zoneOf(settings))}`,
      "Look them over together, with the full picture: what they add up to, what changed for the owner, and whether anything here is worth telling them now after all, or doing something about. One nudge at most, for what matters most, or none. What doesn't need saying, leave: they'll see it when they ask what you've noticed.",
      listsLine(settings),
      reactionsLine(this.d.sql),
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = await this.d.wake({ trigger: "senses:review", note, from: "noticing" });
    if (!out.error)
      markSeen(
        this.d.sql,
        pile.map((i) => i.id),
      );
    this.#log(
      {
        event: `A look at ${pile.length} thing${pile.length === 1 ? "" : "s"} that could wait`,
        step: "review",
        count: pile.length,
        outcome: out.error ? "failed" : out.nudged ? "nudged" : "silent",
        why: out.error ?? "",
        ms: Date.now() - t0,
      },
      out.run_id,
    );
  }

  /**
   * What an item could matter to: open tasks (those that fit at a place,
   * with a person, or in words), and commitments, goals, reminders and
   * promises coming up. Plain to-dos with no fit aren't asked about.
   */
  #openThings(settings: Settings): OpenThing[] {
    const out: OpenThing[] = [];
    for (const t of openTasks(this.d.sql).slice(0, 25)) {
      const f = fitsOf(t);
      const fits = fitsText(f);
      if (!fits) continue;
      const text = `the task "${t.name}" (${fits}) (id ${t.id})`;
      if (f.kind || f.place) {
        out.push({ id: t.id, kind: "place", title: t.name, text, question: "", ...(f.place ? { place: f.place } : {}) });
        continue;
      }
      out.push({
        id: t.id,
        kind: "task",
        title: t.name,
        text,
        ...(f.person ? { person: f.person } : {}),
        question: f.person
          ? `The owner wants to "${t.name}" next time they're in touch with ${f.person}. Is this item from, with or about ${f.person}?`
          : `The owner wants to "${t.name}" ${f.words}. Does this item mean now is that time?`,
      });
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
          question: `The owner has a ${i.kind} due ${shortLocal(new Date(i.due_at), zoneOf(settings))}: "${i.title}". Does this event change something about it: its time, its place, or whether it can still happen? Just being out and about isn't enough.`,
        });
      }
      for (const r of findRecords(this.d.sql, "goal").slice(0, 5)) {
        out.push({
          id: r.id,
          kind: "commitment",
          title: r.name,
          text: `the goal or project "${r.name}"`,
          question: `The owner is working toward: "${r.name}"${typeof r.fields.fact === "string" ? ` (${r.fields.fact})` : ""}. Does this event matter to it now?`,
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

  // --- the moment before each event ---------------------------------------------------------------

  /**
   * The moment before each event in the next day (§10.3): ten minutes
   * before it starts, or before leave-by when there's a trip to it and that
   * look is on, an item goes to the intake. One per event and start time:
   * a moved event gets a new one, and one that's gone ends.
   */
  async #armSoon(settings: Settings, now = Date.now()): Promise<void> {
    const c = cache(this.d.sql);
    const want = new Map<string, { at: number; e: SituationEvent; start: number }>();
    for (const e of c.events) {
      const start = Date.parse(e.start);
      if (e.all_day || !(start > now) || start - now > 86_400_000) continue;
      const trip = c.travel && c.travel.event_id === e.id && isOn(settings, "leave") ? c.travel.leave_by - LEAVE_LEAD_MS : Infinity;
      const at = Math.max(now + 60_000, Math.min(start - SOON_MS, trip));
      if (at < start) want.set(`${e.id}|${start}`, { at, e, start });
    }
    const open = upcoming(this.d.sql, 500).filter(
      (i) => i.kind === "rhythm" && i.state === "scheduled" && (i.source.detail?.moment === "soon" || i.source.detail?.moment === "leave"),
    );
    const kept = new Map<string, AgendaItem>();
    for (const o of open) {
      const key = `${String(o.source.detail?.event_id)}|${Number(o.source.detail?.start)}`;
      if (o.source.detail?.moment === "soon" && want.has(key) && !kept.has(key)) {
        kept.set(key, o);
        continue;
      }
      await this.d.clock.unschedule(o);
      finish(this.d.sql, o.id, "cancelled", null, { why: "The event moved or is gone." });
    }
    for (const [key, w] of want) {
      // Once per event and start: one that already ran isn't made again.
      const ran = this.d.sql
        .exec(
          `SELECT 1 FROM agenda WHERE kind = 'rhythm' AND json_extract(source, '$.detail.event_id') = ? AND json_extract(source, '$.detail.start') = ? AND state IN ('done', 'running') LIMIT 1`,
          w.e.id,
          w.start,
        )
        .toArray().length;
      if (ran) continue;
      const mine = kept.get(key);
      if (mine && Math.abs(mine.due_at - w.at) < 60_000) continue;
      const item = mine
        ? rearm(this.d.sql, mine.id, w.at)!
        : createItem(this.d.sql, {
            kind: "rhythm",
            title: `Coming up: ${w.e.title}`,
            due_at: w.at,
            source: { via: "senses", detail: { moment: "soon", event_id: w.e.id, start: w.start } },
          });
      await this.d.clock.schedule(item);
    }
  }

  /**
   * The moment before an event came due (the item is already leased): the
   * event, who it's with and the trip to it, if any, go to the intake as an
   * item, weighed like any other. The look before leaving and the daily
   * looks were moments of their own before; an item left from then ends.
   */
  async moment(item: AgendaItem): Promise<void> {
    const moment = String(item.source.detail?.moment ?? "");
    if (moment !== "soon") {
      finish(this.d.sql, item.id, "cancelled", null, {
        why:
          moment === "leave"
            ? "The look before leaving is the moment before each event now."
            : "The daily looks are the morning brief and evening wrap-up now.",
      });
      return;
    }
    await this.refresh(true);
    const tz = zoneOf(readSettings(this.d.sql));
    const c = cache(this.d.sql);
    const e = c.events.find((x) => x.id === item.source.detail?.event_id);
    const start = e ? Date.parse(e.start) : NaN;
    if (!e || start !== item.source.detail?.start) {
      finish(this.d.sql, item.id, "cancelled", null, { why: "The event moved or is gone." });
      return;
    }
    const t = c.travel && c.travel.event_id === e.id ? c.travel : null;
    const place = placeOf(e);
    const trip = t
      ? `. About ${minutes(t.s)} by car from ${t.from_what === "here" ? "where they are" : "home"}${t.traffic ? " with traffic" : ", typical time with no live traffic"}: leave by ${clockLocal(new Date(t.leave_by), tz)}`
      : "";
    this.take([
      {
        source: "calendar",
        event: "soon",
        what: `Coming up at ${clockLocal(new Date(start), tz)}: "${e.title}"${place ? `, at ${place}` : ""}${withText(e)}${trip}`,
        key: `soon:${e.id}:${start}`,
        thread: e.id,
        title: e.title,
        start: e.start,
        ...(e.location ? { location: e.location } : {}),
        ...(e.people?.length ? { people: e.people.map(personText) } : {}),
        ...(t ? { leave_by: t.leave_by } : {}),
        text: `${e.title} ${e.location ?? ""}`.slice(0, 400),
      },
    ]);
    finish(this.d.sql, item.id, "done", null);
  }

  /**
   * What a run of Atlas's own on the clock needs to look at the day (§13.4):
   * what came in that could wait, what it already said today, the owner's
   * lists, and how its last nudges landed. `seen` marks the pile looked at,
   * once the run has finished.
   */
  picture(): { text: string; seen: () => void } {
    const settings = readSettings(this.d.sql);
    const tz = zoneOf(settings);
    const pile = laterPile(this.d.sql, 30);
    const said = saidToday(this.d.sql, tz);
    const text = [
      pile.length
        ? `What came in since your last look, which could wait until now (look it over with the rest):\n${pileList(pile, tz)}`
        : "",
      said.length ? `What you've already said on your own today (never say it again):\n${said.map((x) => `- ${x}`).join("\n")}` : "",
      listsLine(settings),
      reactionsLine(this.d.sql),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      text,
      seen: () =>
        markSeen(
          this.d.sql,
          pile.map((i) => i.id),
        ),
    };
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
            about: { instructions: "Is the owner's reply about Atlas's message, rather than about something else?" },
            stop: { instructions: "Is the owner asking Atlas to stop sending messages like this one?" },
            thanks: { instructions: "Is the owner thanking Atlas, or saying the message was useful?" },
          },
          AbortSignal.timeout(3_000),
        );
        // Something else entirely isn't a reaction to the nudge; it may still come.
        if ((p.about ?? 1) < 0.4 && (p.stop ?? 0) < 0.6 && (p.thanks ?? 0) < 0.6) return null;
        reaction = (p.stop ?? 0) >= 0.6 ? "stop" : (p.thanks ?? 0) >= 0.6 ? "thanks" : "replied";
      } catch (err) {
        // Without decide's word, a reply can't be told from one about something else, so it isn't counted.
        console.error(JSON.stringify({ at: "awareness.reaction", error: err instanceof Error ? err.message : String(err) }));
        return null;
      }
    }
    this.#react(n, reaction);
    if (reaction !== "stop") return null;
    const moment =
      n.from === "routine"
        ? ` It came from one of the owner's automations (id ${n.ref ?? "?"}): if they mean that whole routine, turn it off or change it with automation_set or automation_save, not speaking_up.`
        : n.from === "leave"
          ? ` It came from ${NUDGE_WORDS.leave}, which has its own switch.`
          : "";
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

const titleOf = (open: Array<{ id: string; title: string }>, id: string) => open.find((o) => o.id === id)?.title ?? id;

/** Decide's own questions for every item, whatever is open: worth a thought now, or worth knowing later. */
const NOW = "worth_a_thought_now";
const LATER = "worth_knowing_later";

const prefs = (s: Settings) =>
  [
    s.speaking.tell_about.length
      ? `They asked to always hear about: ${s.speaking.tell_about.join("; ")}; something about those is a yes.`
      : "",
    s.speaking.quiet_about.length
      ? `They asked not to hear about: ${s.speaking.quiet_about.join("; ")}; something only about those is a no.`
      : "",
  ].filter(Boolean);

function nowQuestion(s: Settings): string {
  return [
    "Something just came in about the owner's world (above, with their situation).",
    "Would a thoughtful personal assistant who knows them well want to think about it right now, because it's urgent or timely: it could change their plans or timing in the next hours, it needs them soon, or it matters to their safety or money?",
    "Ordinary comings and goings, and news that can wait, are a no.",
    ...prefs(s),
  ].join(" ");
}

function laterQuestion(s: Settings): string {
  return [
    "Something just came in about the owner's world (above).",
    "Is it worth knowing about today, though it can wait: something that changes what's coming, needs them eventually, or is about a person, project or plan they care about?",
    "Routine noise that changes nothing for them (a move that goes nowhere new, a device going idle, a newsletter) is a no.",
    ...prefs(s),
  ].join(" ");
}

/** The pile as lines for a note. */
function pileList(pile: IntakeItem[], tz: string): string {
  return [...pile]
    .reverse()
    .map((i) => `- ${clockLocal(new Date(i.at), tz)}: ${i.what} (${i.source})`)
    .join("\n");
}

/** What a run woken by a sense is asked to do: think, and speak only if it helps. The judgment is Atlas's own. */
const AWARE = [
  "This is your chance to be useful without being asked. Think about what it means for the owner right now, given the situation, their calendar, tasks, reminders and people, and what you know of them, and connect the dots they'd want connected.",
  "Check it can happen now: the time of day (a store at 2 AM is likely closed; say so or wait), where they are, and what they're doing.",
  "Look things up if that would help (a route, a place on their way, the weather, their calendar), and do what's yours to do. If telling them now would help, nudge once, in a sentence or two, the way you'd text a friend.",
  "If it wouldn't (it changes nothing for them, it can wait, you'd be guessing, they're busy), don't nudge: end with a few words for your own log saying why. Silence is often right.",
].join(" ");

/** What the owner asked to always hear about, and never, for Atlas's note. */
function listsLine(s: Settings): string {
  return [
    s.speaking.tell_about.length ? `The owner asked you to always bring up: ${s.speaking.tell_about.join("; ")}.` : "",
    s.speaking.quiet_about.length ? `The owner asked you not to bring up: ${s.speaking.quiet_about.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What came in that could wait, for the owner's own turns: "since you last looked". */
/** How much of the later pile an owner's turn sees. */
const PILE_SHOWN = 8;

export function pileLine(sql: Sql, settings: Settings): string {
  const pile = laterPile(sql, PILE_SHOWN);
  if (!pile.length) return "";
  return `Noticed since your last look, and could wait (bring it up only if it fits; noticed has the rest):\n${pileList(pile, zoneOf(settings))}`;
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
  const keys = Object.keys(NUDGE_WORDS) as Array<keyof typeof NUDGE_WORDS>;
  const on = keys.filter((k) => isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  const off = keys.filter((k) => !isOn(s, k)).map((k) => NUDGE_WORDS[k]);
  return [
    `Speaking up on your own (Settings → Notifications → Speaking up; change it with speaking_up): ${on.length ? `on for ${on.join(", ")}` : "off for everything"}${on.length && off.length ? `; off for ${off.join(", ")}` : ""}.`,
    s.speaking.tell_about.length ? ` The owner asked you to always bring up: ${s.speaking.tell_about.join("; ")}.` : "",
    s.speaking.quiet_about.length ? ` The owner asked you not to bring up: ${s.speaking.quiet_about.join("; ")}.` : "",
    " When the owner asks why you didn't tell them something, or what you noticed, look it up with noticed before you answer; never guess what you saw or decided.",
    " These lists are exactly what's set now: one not shown here is empty, whatever earlier in the conversation says was added. Never say you changed how you'll speak up without changing it with speaking_up.",
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

/**
 * The owner's Speaking up, changed by Atlas when they ask ("stop telling me
 * about the weather", "do the morning look at seven"). It's their own
 * setting, so Atlas just does it, with a receipt and Undo (§12.1).
 */
export const speakingUp = defineTool({
  name: "speaking_up",
  kind: "change_own",
  description: [
    "Change what you bring up on your own, when the owner asks: add or remove subjects they don't want to hear about (in their words, as narrow or broad as they meant: 'the weather unless it's severe', 'errands'), subjects they always want to hear about ('anything from my landlord', 'reviews requested on my PRs'), or switch what you notice and the look before leaving for events.",
    "The morning brief and the evening wrap-up are automations: change their time or turn them off with automation_save or automation_set.",
    "They see a receipt with Undo, and it all shows in Settings → Notifications → Speaking up.",
  ].join(" "),
  input: z.object({
    quiet_about_add: z.array(z.string().min(1).max(120)).max(5).optional(),
    quiet_about_remove: z.array(z.string().min(1).max(120)).max(5).optional(),
    tell_about_add: z.array(z.string().min(1).max(120)).max(5).optional(),
    tell_about_remove: z.array(z.string().min(1).max(120)).max(5).optional(),
    noticing: z.boolean().optional().describe("Whether you speak up about what your senses notice."),
    leave: z.boolean().optional().describe("Whether you look before they leave for an event with a place."),
  }),
  async run(input, ctx) {
    const before = readSettings(ctx.sql).speaking;
    const lower = (x: string) => x.trim().toLowerCase();
    const edit = (list: string[], add: string[] = [], remove: string[] = []) => {
      const drop = new Set(remove.map(lower));
      const out = list.filter((q) => !drop.has(lower(q)));
      for (const q of add) if (!out.some((x) => lower(x) === lower(q))) out.push(q.trim());
      return out.slice(-30);
    };
    const after: Settings["speaking"] = {
      noticing: input.noticing ?? before.noticing,
      leave: input.leave ?? before.leave,
      quiet_about: edit(before.quiet_about, input.quiet_about_add, input.quiet_about_remove),
      tell_about: edit(before.tell_about, input.tell_about_add, input.tell_about_remove),
    };
    if (JSON.stringify(after) === JSON.stringify(before)) return { ok: true, output: { changed: false, speaking: before } };
    writeSettings(ctx.sql, { speaking: after });
    append(ctx.sql, { actor: "atlas", kind: "settings.change", run_id: ctx.run_id, body: { keys: ["speaking"], why: "asked in chat" } });
    await ctx.speaking?.();
    const said = [
      ...(input.quiet_about_add ?? []).map((q) => `won't bring up ${q}`),
      ...(input.quiet_about_remove ?? []).map((q) => `may bring up ${q} again`),
      ...(input.tell_about_add ?? []).map((q) => `will always bring up ${q}`),
      ...(input.tell_about_remove ?? []).map((q) => `no longer always brings up ${q}`),
      ...(["noticing", "leave"] as const).filter((k) => input[k] != null).map((k) => `${NUDGE_WORDS[k]} ${input[k] ? "on" : "off"}`),
    ];
    return {
      ok: true,
      output: { changed: true, speaking: after },
      receipt: { text: `Speaking up · ${said.join(", ") || "changed"}`, undo: { kind: "speaking.restore", before } },
    };
  },
});
