// The calendar sense (§10.1): iCloud over CalDAV, built from the owner's
// credentials, with a copy of the calendar kept between turns. When iCloud
// can't be asked (it refused the sign-in, or it's down), reads answer from
// the copy and say how old it is, and Atlas tries iCloud again by itself
// later, spaced out so a refusal is never retried in a burst.

import { cleanCredentials, type CalendarCopy, icloudCalendar } from "../calendar/caldav";
import { type Calendar, CalendarError, type CalendarRange, type CalendarSource, type ICloudCredentials } from "../calendar/types";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { getSecret, type Settings } from "../store/settings";
import { getState, setState } from "../store/state";
import { shortLocal, zoneOf } from "../time";
import { seams } from "./seams";

export interface Refusal {
  at: number;
  message: string;
  /** Refusals in a row. */
  tries: number;
  /** Atlas doesn't sign in to iCloud again before this, unless the owner presses Test or reconnects. */
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
  ) {}

  /** The calendar for a run, or null when it isn't connected. */
  source(settings: Settings): Calendar | null {
    if (seams.calendar !== undefined) return seams.calendar ? this.#guarded(seams.calendar, settings) : null;
    const creds = getSecret<ICloudCredentials>(this.sql, "icloud");
    if (!creds) return null;
    const key = `${creds.username}|${creds.app_password}|${settings.calendar.hidden.join(",")}|${settings.timezone}`;
    if (this.#built?.key !== key) {
      const source = icloudCalendar(creds, {
        hidden: settings.calendar.hidden,
        timezone: zoneOf(settings),
        store: {
          load: () => getState<CalendarCopy>(this.sql, "icloud_copy"),
          save: (copy) => setState(this.sql, "icloud_copy", copy),
        },
        ...(seams.fetch ? { fetch: seams.fetch } : {}),
      });
      this.#built = { key, calendar: this.#guarded(source, settings) };
    }
    return this.#built.calendar;
  }

  /** Settings changed: build the source again on next use. */
  reset(): void {
    this.#built = null;
  }

  /** New credentials: start fresh, and let Atlas ask iCloud at once. */
  reconnect(): void {
    this.#built = null;
    setState(this.sql, "icloud_refused", null);
    setState(this.sql, "icloud_copy", null);
  }

  refusal(): Refusal | null {
    return getState<Refusal>(this.sql, "icloud_refused");
  }

  /**
   * What Atlas holds for iCloud, without the password itself, so the owner can
   * tell whether it's what they meant to paste.
   */
  shape(): string {
    const creds = getSecret<ICloudCredentials>(this.sql, "icloud");
    if (!creds) return "";
    const c = cleanCredentials(creds);
    return /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(c.app_password)
      ? `Atlas is signing in as ${c.username} with an app-specific password in Apple's xxxx-xxxx-xxxx-xxxx form.`
      : `Atlas is signing in as ${c.username} with a ${c.app_password.length}-character password that isn't in Apple's xxxx-xxxx-xxxx-xxxx form, so it may be the Apple ID's own password, which iCloud refuses here.`;
  }

  /** What the owner and the brain are told while iCloud is refusing: what happened, and when Atlas tries again. */
  note(r: Refusal, settings: Settings): string {
    const tz = zoneOf(settings);
    const again = `Atlas will try again by itself after ${shortLocal(new Date(r.next_try), tz)}.`;
    const long =
      r.tries >= 4
        ? " It has refused for about a day. If the Apple ID password was changed, Apple revoked the app-specific password; a new one from account.apple.com fixes that."
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
   * Reads go to iCloud only when the source's copy is old, and never while
   * a refusal's wait is running: retrying a refused sign-in quickly is how
   * Apple accounts get locked. Meanwhile, and whenever iCloud can't be asked,
   * the copy answers, with its age and the reason.
   */
  #guarded(source: CalendarSource, settings: Settings): Calendar {
    const fallback = (range: CalendarRange, why: string, code: CalendarError["code"]) => {
      const held = source.held?.(range);
      if (held && Date.now() - held.as_of < STALE_LIMIT_MS) return { events: held.events, stale: { as_of: held.as_of, why } };
      throw new CalendarError(why, code);
    };
    return {
      read: async (range) => {
        const waiting = this.refusal();
        if (waiting && waiting.next_try > Date.now()) return fallback(range, this.note(waiting, settings), "auth");
        try {
          const events = await source.list(range);
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
