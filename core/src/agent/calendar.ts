// The calendar sense (§10.1): whichever extension provides the calendar
// (§17), iCloud over CalDAV by default, with its copy kept between turns.
// When the provider can't be asked (it refused the sign-in, or it's down),
// reads answer from the copy and say how old it is, and Atlas tries again
// by itself later, spaced out so a refusal is never retried in a burst.
// That guard is the core's, whatever the provider.

import { othersOf } from "../contacts";
import { ExtensionError, type ExtensionHost } from "../extensions";
import { pick } from "../providers";
import { type Calendar, type CalendarEvent, CalendarError, type CalendarRange, type CalendarSource } from "../calendar/types";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import type { Settings } from "../store/settings";
import { getState, setState } from "../store/state";
import { shortLocal, zoneOf } from "../time";
import { seams } from "./seams";

export interface Refusal {
  at: number;
  message: string;
  /** Refusals in a row. */
  tries: number;
  /** Atlas doesn't sign in to the calendar again before this, unless the owner presses Test or reconnects. */
  next_try: number;
}

/** After the nth refusal in a row, wait this long before trying again by itself. */
export const RETRY_AFTER_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
/** A copy older than this isn't used to answer: better to say the calendar can't be read. */
export const STALE_LIMIT_MS = 3 * 86_400_000;

export class CalendarSense {
  #built: { key: string; calendar: Calendar } | null = null;

  constructor(
    private readonly sql: Sql,
    /** Called when what the app shows about the calendar changed. */
    private readonly changed: () => void,
    private readonly host: ExtensionHost,
  ) {}

  /** The extension that provides the calendar, if one is on. */
  provider() {
    return pick(this.sql, "calendar", "calendar");
  }

  /** The calendar for a run, or null when none is connected. */
  source(settings: Settings): Calendar | null {
    if (seams.calendar !== undefined) return seams.calendar ? this.#guarded(seams.calendar, settings) : null;
    const ext = this.provider();
    if (!ext) return null;
    const key = `${ext.id}|${ext.updated_at}|${settings.calendar.hidden.join(",")}|${settings.timezone}`;
    if (this.#built?.key !== key)
      this.#built = { key, calendar: this.#guarded(this.#fromExtension(ext.id, settings.calendar.hidden), settings) };
    return this.#built.calendar;
  }

  /** A calendar source that asks the extension, with its failures as calendar errors the guard understands. */
  #fromExtension(id: string, hidden: string[]): CalendarSource {
    const ask = async (range: CalendarRange, held: boolean) => {
      try {
        return await this.host.call<{ events: CalendarEvent[]; as_of?: number }>(id, "calendar", [
          { start: range.start.toISOString(), end: range.end.toISOString(), hidden, ...(held ? { held: true } : {}) },
        ]);
      } catch (err) {
        const code = err instanceof ExtensionError && (err.code === "auth" || err.code === "network") ? err.code : "protocol";
        throw new CalendarError(err instanceof Error ? err.message : String(err), code);
      }
    };
    return {
      list: async (range) => (await ask(range, false)).events,
      held: async (range) => {
        const r = await ask(range, true).catch(() => null);
        return r?.as_of ? { events: r.events, as_of: r.as_of } : null;
      },
      check: async () => {
        try {
          return { text: (await this.host.call<{ text: string }>(id, "test")).text };
        } catch (err) {
          const code = err instanceof ExtensionError && (err.code === "auth" || err.code === "network") ? err.code : "protocol";
          throw new CalendarError(err instanceof Error ? err.message : String(err), code);
        }
      },
    };
  }

  /** Settings changed: build the source again on next use. */
  reset(): void {
    this.#built = null;
  }

  /** New credentials: start fresh, and let Atlas ask the provider at once. */
  reconnect(): void {
    this.#built = null;
    setState(this.sql, "icloud_refused", null);
  }

  /** The refusal on record. One saved by an older version has only `at` and `message`; it reads as a first refusal. */
  refusal(): Refusal | null {
    const r = getState<Partial<Refusal>>(this.sql, "icloud_refused");
    if (!r) return null;
    const at = Number.isFinite(r.at) ? r.at! : Date.now();
    const tries = Number.isFinite(r.tries) && r.tries! > 0 ? r.tries! : 1;
    const next_try = Number.isFinite(r.next_try) ? r.next_try! : at + RETRY_AFTER_MS[0]!;
    return { at, message: typeof r.message === "string" ? r.message : "The calendar refused the sign-in", tries, next_try };
  }

  /** What the owner and the brain are told while the calendar is refusing: what happened, and when Atlas tries again. */
  note(r: Refusal, settings: Settings): string {
    const tz = zoneOf(settings);
    const again = `Atlas will try again by itself after ${shortLocal(new Date(r.next_try), tz)}.`;
    const long =
      r.tries >= 4
        ? " It has refused for about a day. If the account's password was changed, the password Atlas has may have been revoked; a new one in Settings → Extensions fixes that."
        : "";
    return `${r.message}, at ${shortLocal(new Date(r.at), tz)}. ${again}${long}`;
  }

  #refused(err: CalendarError): Refusal {
    const prev = this.refusal();
    const tries = (prev?.tries ?? 0) + 1;
    const at = Date.now();
    const r: Refusal = { at, message: err.message, tries, next_try: at + RETRY_AFTER_MS[Math.min(tries, RETRY_AFTER_MS.length) - 1]! };
    setState(this.sql, "icloud_refused", r);
    append(this.sql, { actor: "system", kind: "settings.change", body: { icloud: "refused", message: err.message, tries } });
    this.changed();
    return r;
  }

  #accepted(): void {
    if (!this.refusal()) return;
    setState(this.sql, "icloud_refused", null);
    append(this.sql, { actor: "system", kind: "settings.change", body: { icloud: "accepted" } });
    this.changed();
  }

  /**
   * Reads go to the provider only when the source's copy is old, and never while
   * a refusal's wait is running: retrying a refused sign-in quickly is how
   * accounts get locked (Apple's do). Meanwhile, and whenever it can't be asked,
   * the copy answers, with its age and the reason.
   */
  /** The owner is on most of their own invites; who an event is with means everyone else (§7.1). */
  #others(e: CalendarEvent): CalendarEvent {
    if (!e.people?.length) return e;
    const { people: _p, ...rest } = e;
    const people = othersOf(this.sql, e.people);
    return people ? { ...rest, people } : rest;
  }

  #guarded(source: CalendarSource, settings: Settings): Calendar {
    const fallback = async (range: CalendarRange, why: string, code: CalendarError["code"]) => {
      const held = (await source.held?.(range)) ?? null;
      if (held && Date.now() - held.as_of < STALE_LIMIT_MS)
        return { events: held.events.map((e) => this.#others(e)), stale: { as_of: held.as_of, why } };
      throw new CalendarError(why, code);
    };
    return {
      read: async (range) => {
        const waiting = this.refusal();
        if (waiting && waiting.next_try > Date.now()) return fallback(range, this.note(waiting, settings), "auth");
        try {
          const events = (await source.list(range)).map((e) => this.#others(e));
          this.#accepted();
          return { events };
        } catch (err) {
          if (!(err instanceof CalendarError)) throw err;
          if (err.code === "auth") return fallback(range, this.note(this.#refused(err), settings), "auth");
          return fallback(range, err.message, err.code);
        }
      },
      // The owner pressing Test is always one fresh try.
      check: async () => {
        try {
          const c = await source.check();
          this.#accepted();
          return c;
        } catch (err) {
          if (err instanceof CalendarError && err.code === "auth") this.#refused(err);
          throw err;
        }
      },
    };
  }
}
