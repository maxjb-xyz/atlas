// The calendar sense (§10.1): iCloud over CalDAV, built from the owner's
// credentials and kept between turns, with a guard that stops asking iCloud
// after it refuses the password.

import { icloudCalendar, type RememberedCalendars } from "../calendar/caldav";
import { CalendarError, type CalendarSource, type ICloudCredentials } from "../calendar/types";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { getSecret, type Settings } from "../store/settings";
import { getState, setState } from "../store/state";
import { shortLocal, zoneOf } from "../time";
import { seams } from "./seams";

export interface Refusal {
  at: number;
  message: string;
}

export class CalendarSense {
  #built: { key: string; source: CalendarSource } | null = null;

  constructor(
    private readonly sql: Sql,
    /** Called when what the app shows about the calendar changed. */
    private readonly changed: () => void,
  ) {}

  /** The calendar for a run, or null when it isn't connected. */
  source(settings: Settings): CalendarSource | null {
    if (seams.calendar !== undefined) return seams.calendar ? this.#guarded(seams.calendar, settings) : null;
    const creds = getSecret<ICloudCredentials>(this.sql, "icloud");
    if (!creds) return null;
    const key = `${creds.username}|${creds.app_password.length}|${settings.calendar.hidden.join(",")}|${settings.timezone}`;
    if (this.#built?.key !== key) {
      const source = icloudCalendar(creds, {
        hidden: settings.calendar.hidden,
        timezone: zoneOf(settings),
        remember: {
          load: () => getState<RememberedCalendars>(this.sql, "icloud_calendars"),
          save: (cals) => setState(this.sql, "icloud_calendars", cals),
        },
        ...(seams.fetch ? { fetch: seams.fetch } : {}),
      });
      this.#built = { key, source: this.#guarded(source, settings) };
    }
    return this.#built.source;
  }

  /** Settings changed: build the source again on next use. */
  reset(): void {
    this.#built = null;
  }

  /** New credentials: start fresh, and let Atlas ask iCloud again. */
  reconnect(): void {
    this.#built = null;
    setState(this.sql, "icloud_refused", null);
    setState(this.sql, "icloud_calendars", null);
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
    const p = creds.app_password;
    const form = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(p)
      ? "in Apple's xxxx-xxxx-xxxx-xxxx form"
      : "not in Apple's xxxx-xxxx-xxxx-xxxx form, so it may not be an app-specific password";
    return `Atlas is signing in as ${creds.username} with a ${p.length}-character password ${form}.`;
  }

  /**
   * After iCloud refuses the password, Atlas stops asking until the owner
   * reconnects. Retrying a refused login (the brain can call the calendar
   * several times in one reply) is how Apple accounts get locked.
   */
  #guarded(source: CalendarSource, settings: Settings): CalendarSource {
    const refused = (err: unknown) => {
      if (err instanceof CalendarError && err.code === "auth") {
        setState(this.sql, "icloud_refused", { at: Date.now(), message: err.message });
        append(this.sql, { actor: "system", kind: "settings.change", body: { icloud: "refused", message: err.message } });
        this.changed();
      }
      return err;
    };
    return {
      list: async (range) => {
        const stopped = this.refusal();
        if (stopped) {
          throw new CalendarError(
            `iCloud refused the Apple ID and app-specific password at ${shortLocal(new Date(stopped.at), zoneOf(settings))}, so Atlas stopped asking, to keep Apple from locking the account. Reconnect in Settings → Calendar.`,
            "auth",
          );
        }
        return source.list(range).catch((err: unknown) => {
          throw refused(err);
        });
      },
      // The owner pressing Test is always one fresh try.
      check: async () => {
        const c = await source.check().catch((err: unknown) => {
          throw refused(err);
        });
        setState(this.sql, "icloud_refused", null);
        this.changed();
        return c;
      },
    };
  }
}
