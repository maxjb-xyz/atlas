// The calendar sense (§10.1): whichever extension provides the calendar
// (§17), iCloud over CalDAV by default, with its copy kept between turns.
// When the provider can't be asked (it refused the sign-in, or it's down),
// reads answer from the copy and say how old it is, and Atlas tries again
// by itself later, spaced out so a refusal is never retried in a burst.
// That guard is the core's, whatever the provider.

import { othersOf } from "../contacts";
import { accountName, ExtensionError, type ExtensionHost, type Installed, methodsOf, providing, ready } from "../extensions";
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

const startMs = (e: CalendarEvent) => (e.all_day ? new Date(`${e.start}T00:00`).getTime() : new Date(e.start).getTime());

export class CalendarSense {
  #built: { key: string; calendar: Calendar } | null = null;
  /** Which calendar each event was read from, so a move goes back to it. */
  #from = new Map<string, string>();

  constructor(
    private readonly sql: Sql,
    /** Called when what the app shows about the calendar changed. */
    private readonly changed: () => void,
    private readonly host: ExtensionHost,
  ) {}

  /** The calendars that are on: every account of every service that gives one, oldest first. */
  providers(): Installed[] {
    // One that isn't signed in yet (an account just added) isn't asked, so it can't count as a refusal.
    return providing(this.sql, "calendar").filter((e) => methodsOf(e).includes("calendar") && ready(this.sql, e));
  }

  /** The first calendar, if one is on. */
  provider() {
    return pick(this.sql, "calendar", "calendar");
  }

  /** The calendar for a run, or null when none is connected: every account's, read together. */
  source(settings: Settings): Calendar | null {
    if (seams.calendar !== undefined) return seams.calendar ? this.#guarded(seams.calendar, settings, "", "The calendar") : null;
    const all = this.providers();
    if (!all.length) return null;
    const key = `${all.map((e) => `${e.id}@${e.updated_at}`).join(",")}|${settings.calendar.hidden.join(",")}|${settings.timezone}`;
    if (this.#built?.key !== key) {
      const each = all.map((e) => ({
        id: e.id,
        name: accountName(e) ? `${e.name} (${accountName(e)})` : e.name,
        calendar: this.#guarded(this.#fromExtension(e.id, settings.calendar.hidden), settings, e.id, e.name),
      }));
      this.#built = { key, calendar: each.length === 1 ? this.#tracked(each[0]!) : this.#together(each) };
    }
    return this.#built.calendar;
  }

  /** One calendar, noting where its events came from. */
  #tracked(c: { id: string; calendar: Calendar }): Calendar {
    return {
      ...c.calendar,
      read: async (range) => {
        const out = await c.calendar.read(range);
        for (const e of out.events) this.#from.set(e.id, c.id);
        return out;
      },
    };
  }

  /**
   * Several calendars as one (§10.1): each is read, their events together in
   * order. One that can't be read doesn't hide the rest: the read says which
   * and why. Only when none can be read does it fail.
   */
  #together(each: Array<{ id: string; name: string; calendar: Calendar }>): Calendar {
    return {
      read: async (range) => {
        const got = await Promise.allSettled(each.map((c) => c.calendar.read(range)));
        const events: CalendarEvent[] = [];
        const missing: string[] = [];
        const stale: Array<{ as_of: number; why: string }> = [];
        got.forEach((g, i) => {
          const c = each[i]!;
          if (g.status === "rejected") {
            missing.push(`${c.name}: ${g.reason instanceof Error ? g.reason.message : String(g.reason)}`);
            return;
          }
          for (const e of g.value.events) {
            this.#from.set(e.id, c.id);
            events.push(e);
          }
          if (g.value.stale) stale.push({ as_of: g.value.stale.as_of, why: `${c.name}: ${g.value.stale.why}` });
        });
        if (!events.length && missing.length === each.length) {
          const first = got.find((g) => g.status === "rejected") as PromiseRejectedResult;
          throw first.reason instanceof CalendarError ? new CalendarError(missing.join(" "), first.reason.code) : first.reason;
        }
        events.sort((a, b) => startMs(a) - startMs(b));
        return {
          events,
          ...(stale.length ? { stale: { as_of: Math.min(...stale.map((x) => x.as_of)), why: stale.map((x) => x.why).join(" ") } } : {}),
          ...(missing.length ? { missing } : {}),
        };
      },
      move: async (eventId, to) => {
        const id = this.#from.get(eventId);
        const c = each.find((x) => x.id === id);
        if (!c)
          throw new CalendarError("Atlas doesn't know which calendar that event is on yet: read the calendar, then move it.", "protocol");
        if (!c.calendar.move) throw new CalendarError(`${c.name} can't move events.`, "protocol");
        return c.calendar.move(eventId, to);
      },
      check: async () => {
        const got = await Promise.allSettled(each.map((c) => c.calendar.check()));
        const ok = got.flatMap((g, i) => (g.status === "fulfilled" ? [{ c: each[i]!, v: g.value }] : []));
        const bad = got.flatMap((g, i) =>
          g.status === "rejected" ? [`${each[i]!.name}: ${g.reason instanceof Error ? g.reason.message : String(g.reason)}`] : [],
        );
        if (!ok.length) throw new CalendarError(bad.join(" "), "auth");
        return {
          calendars: ok.flatMap((x) => x.v.calendars ?? []),
          events_next_30_days: ok.reduce((n, x) => n + (x.v.events_next_30_days ?? 0), 0),
          text: [...ok.map((x) => `${x.c.name}: ${x.v.text ?? "read"}`), ...bad].join(" "),
        };
      },
    };
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
      move: async (eventId, to) => {
        try {
          return await this.host.call<{ before: CalendarEvent; event: CalendarEvent }>(id, "move", [{ id: eventId, ...to }]);
        } catch (err) {
          const code = err instanceof ExtensionError && (err.code === "auth" || err.code === "network") ? err.code : "protocol";
          throw new CalendarError(err instanceof Error ? err.message : String(err), code);
        }
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

  /** New credentials for a calendar (or all): start fresh, and let Atlas ask it at once. */
  reconnect(id?: string): void {
    this.#built = null;
    const all = this.#refusals();
    if (id) delete all[id];
    setState(this.sql, "calendar_refusals", id ? all : {});
    setState(this.sql, "icloud_refused", null);
  }

  /** Each calendar's refusal, by its extension. One saved by an older version belongs to the first calendar. */
  #refusals(): Record<string, Partial<Refusal>> {
    const all = { ...(getState<Record<string, Partial<Refusal>>>(this.sql, "calendar_refusals") ?? {}) };
    const old = getState<Partial<Refusal>>(this.sql, "icloud_refused");
    const first = seams.calendar !== undefined ? "" : (this.provider()?.id ?? "");
    if (old && !all[first]) all[first] = old;
    return all;
  }

  /** A calendar's refusal on record; with no id, the first one refusing. One saved by an older version has only `at` and `message`. */
  refusal(id?: string): Refusal | null {
    const all = this.#refusals();
    const r =
      id !== undefined
        ? all[id]
        : (this.providers()
            .map((p) => all[p.id])
            .find(Boolean) ?? all[""]);
    if (!r) return null;
    const at = Number.isFinite(r.at) ? r.at! : Date.now();
    const tries = Number.isFinite(r.tries) && r.tries! > 0 ? r.tries! : 1;
    const next_try = Number.isFinite(r.next_try) ? r.next_try! : at + RETRY_AFTER_MS[0]!;
    return { at, message: typeof r.message === "string" ? r.message : "The calendar refused the sign-in", tries, next_try };
  }

  /** What the owner and the brain are told while a calendar is refusing: what happened, and when Atlas tries again. */
  note(r: Refusal, settings: Settings): string {
    const tz = zoneOf(settings);
    const again = `Atlas will try again by itself after ${shortLocal(new Date(r.next_try), tz)}.`;
    const long =
      r.tries >= 4
        ? " It has refused for about a day. If the account's password was changed, the password Atlas has may have been revoked; a new one in Abilities → Services fixes that."
        : "";
    return `${r.message}, at ${shortLocal(new Date(r.at), tz)}. ${again}${long}`;
  }

  #refused(id: string, name: string, err: CalendarError): Refusal {
    const prev = this.refusal(id);
    const tries = (prev?.tries ?? 0) + 1;
    const at = Date.now();
    const r: Refusal = { at, message: err.message, tries, next_try: at + RETRY_AFTER_MS[Math.min(tries, RETRY_AFTER_MS.length) - 1]! };
    setState(this.sql, "calendar_refusals", { ...this.#refusals(), [id]: r });
    setState(this.sql, "icloud_refused", null);
    append(this.sql, { actor: "system", kind: "settings.change", body: { calendar: "refused", name, message: err.message, tries } });
    this.changed();
    return r;
  }

  #accepted(id: string, name: string): void {
    if (!this.refusal(id)) return;
    const all = this.#refusals();
    delete all[id];
    setState(this.sql, "calendar_refusals", all);
    setState(this.sql, "icloud_refused", null);
    append(this.sql, { actor: "system", kind: "settings.change", body: { calendar: "accepted", name } });
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

  #guarded(source: CalendarSource, settings: Settings, id: string, name: string): Calendar {
    const fallback = async (range: CalendarRange, why: string, code: CalendarError["code"]) => {
      const held = (await source.held?.(range)) ?? null;
      if (held && Date.now() - held.as_of < STALE_LIMIT_MS)
        return { events: held.events.map((e) => this.#others(e)), stale: { as_of: held.as_of, why } };
      throw new CalendarError(why, code);
    };
    return {
      read: async (range) => {
        const waiting = this.refusal(id);
        if (waiting && waiting.next_try > Date.now()) return fallback(range, this.note(waiting, settings), "auth");
        try {
          const events = (await source.list(range)).map((e) => this.#others(e));
          this.#accepted(id, name);
          return { events };
        } catch (err) {
          if (!(err instanceof CalendarError)) throw err;
          if (err.code === "auth") return fallback(range, this.note(this.#refused(id, name, err), settings), "auth");
          return fallback(range, err.message, err.code);
        }
      },
      // A change is never made from the copy: it waits out a refusal like a read, then asks the provider.
      ...(source.move
        ? {
            move: async (eventId: string, to: { start: string; end: string }) => {
              const waiting = this.refusal(id);
              if (waiting && waiting.next_try > Date.now()) throw new CalendarError(this.note(waiting, settings), "auth");
              try {
                const out = await source.move!(eventId, to);
                this.#accepted(id, name);
                return out;
              } catch (err) {
                if (err instanceof CalendarError && err.code === "auth")
                  throw new CalendarError(this.note(this.#refused(id, name, err), settings), "auth");
                throw err;
              }
            },
          }
        : {}),
      // The owner pressing Test is always one fresh try.
      check: async () => {
        try {
          const c = await source.check();
          this.#accepted(id, name);
          return c;
        } catch (err) {
          if (err instanceof CalendarError && err.code === "auth") this.#refused(id, name, err);
          throw err;
        }
      },
    };
  }
}
