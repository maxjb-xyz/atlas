// The situation (VISION §10.2): a small live record that's always in
// context. Where you are and since when, what you're doing, what's next and
// when to leave, travel time, weather that matters, and device states. It's
// rebuilt from the latest events, never guessed: where you are comes from
// the phone's last fix and the `sense` rows (core/src/location.ts), and the
// rest from a small cache that a refresh keeps current in the background
// (today's events, the weather for a rough area, the travel time to the
// next event with a place). A prompt reads the cache and never waits on a
// network call, so voice stays fast.

import type { Calendar, CalendarEvent } from "./calendar/types";
import type { SenseItem } from "./store/log";
import { openTasks, taskView } from "./tasks";
import { focusNow } from "./outbox";
import type { SituationPage, WeatherPage } from "./stage";
import { nodes } from "./nodes";
import { here, homePin, metres, nearest, pins } from "./location";
import { type Found, MAPS, minutes, type Point, type Route, type Travel } from "./maps";
import type { Sql } from "./store/db";
import type { Settings } from "./store/settings";
import { getState, setState } from "./store/state";
import { addLocalDays, clockLocal, shortLocal, startOfLocalDay, zoneOf } from "./time";
import type { MapsApi } from "./tools/types";
import { distance, roughArea, unitsFor, type Units, type Weather, weatherLine, whatMatters } from "./weather";

/** An event as the situation keeps it: no notes. */
export type SituationEvent = Pick<CalendarEvent, "id" | "title" | "start" | "end" | "all_day" | "location">;

/** The travel time to an event with a place, from where the owner was when it was worked out. */
export interface TravelTime {
  event_id: string;
  title: string;
  start: number;
  /** The event's place as the calendar has it. */
  location: string;
  to: Point;
  from: Point;
  /** Where the trip starts from: where you are, or home when Atlas doesn't know. */
  from_what: "here" | "home";
  s: number;
  m: number;
  traffic: boolean;
  /** When to leave: the start, less the trip, less a margin (more without traffic). */
  leave_by: number;
  at: number;
  line: Route["line"];
}

export interface SituationCache {
  events: SituationEvent[];
  events_at: number;
  /** Why the calendar couldn't be read, when it couldn't. */
  events_error?: string;
  weather: Weather | null;
  weather_error?: string;
  travel: TravelTime | null;
  travel_error?: string;
  /** Places found for addresses on the calendar, kept (Nominatim's may be), so each is looked up once. Null: not found. */
  places: Record<string, (Point & { name: string }) | null>;
}

const EMPTY: SituationCache = { events: [], events_at: 0, weather: null, travel: null, places: {} };

export const cache = (sql: Sql): SituationCache => ({ ...EMPTY, ...(getState<Partial<SituationCache>>(sql, "situation") ?? {}) });
const save = (sql: Sql, c: SituationCache) => setState(sql, "situation", c);

/** A fresh look at the weather near the owner (the weather tool's) becomes the situation's, so the view and the answer agree. */
export function keepWeather(sql: Sql, w: Weather): void {
  const c = cache(sql);
  save(sql, { ...c, weather: w, weather_error: undefined });
}

/** Weather is looked at most this often, and only while Atlas is in use. */
export const WEATHER_MS = 60 * 60_000;
/** Travel time is worked out again this often for the next event, or sooner after a move. */
export const TRAVEL_MS = 15 * 60_000;
/** Travel time is worked out for an event starting within this. */
export const TRAVEL_AHEAD_MS = 4 * 3_600_000;
/** A fix older than this is said to be old. */
export const STALE_FIX_MS = 3 * 3_600_000;

/** The margin before leave-by: five minutes, or a fifth of the trip without traffic (OpenStreetMap has none). */
export const margin = (s: number, traffic: boolean) => Math.max(5 * 60, traffic ? 5 * 60 : Math.round(s * 0.2));

const startOf = (e: SituationEvent) => new Date(e.start.length === 10 ? `${e.start}T00:00:00` : e.start).getTime();
const endOf = (e: SituationEvent) => new Date(e.end.length === 10 ? `${e.end}T00:00:00` : e.end).getTime();

/** The event under way now (not all-day), if any. */
export function underway(c: SituationCache, now: number): SituationEvent | null {
  return c.events.find((e) => !e.all_day && startOf(e) <= now && endOf(e) > now) ?? null;
}

/** The next event that hasn't started (not all-day), within a day. */
export function nextEvent(c: SituationCache, now: number): SituationEvent | null {
  return (
    c.events.filter((e) => !e.all_day && startOf(e) > now && startOf(e) - now < 86_400_000).sort((a, b) => startOf(a) - startOf(b))[0] ??
    null
  );
}

/** An event's place, when it reads as somewhere to go (not a video call). */
export const placeOf = (e: SituationEvent): string | null => {
  const l = e.location?.trim();
  if (!l || l.length < 4 || /^https?:\/\/|zoom\.us|meet\.google|teams\.microsoft|webex|facetime/i.test(l)) return null;
  return l;
};

export interface RefreshDeps {
  sql: Sql;
  settings: Settings;
  calendar: Calendar | null;
  maps: MapsApi | null;
  now?: number;
  /** The run the looks count against, if any. */
  run_id?: string | null;
  /** Whether to look at the weather and travel time too, not just the calendar. */
  full: boolean;
}

/**
 * Brings the cache up to date: today's and tomorrow's events always, and,
 * when `full`, the weather (hourly at most) and the travel time to the next
 * event with a place (every 15 minutes, or after a move of more than a km).
 * Never throws: what failed is kept with the service's words, for the
 * situation to say.
 */
export async function refresh(d: RefreshDeps): Promise<SituationCache> {
  const now = d.now ?? Date.now();
  const tz = zoneOf(d.settings);
  const c = cache(d.sql);
  if (d.calendar) {
    try {
      const start = startOfLocalDay(new Date(now), tz);
      const read = await d.calendar.read({ start, end: addLocalDays(start, 2, tz) });
      c.events = read.events.map(({ id, title, start, end, all_day, location }) => ({
        id,
        title,
        start,
        end,
        all_day,
        ...(location ? { location } : {}),
      }));
      c.events_at = read.stale?.as_of ?? now;
      delete c.events_error;
    } catch (err) {
      c.events_error = err instanceof Error ? err.message : String(err);
    }
  } else {
    c.events = [];
    c.events_at = 0;
  }
  save(d.sql, c);
  if (!d.full || !d.maps) return c;

  const h = d.settings.location.on ? here(d.sql) : null;
  const home = homePin(d.sql);
  const at: Point | null = h?.fix ? { lat: h.fix.lat, lon: h.fix.lon } : home;
  if (at && (!c.weather || now - c.weather.at >= WEATHER_MS || metres(roughArea(at), c.weather.area) > 15_000)) {
    const out = await d.maps.weather(at, { run_id: d.run_id ?? null, label: "the weather near you" });
    if (out.ok) {
      c.weather = out.value;
      delete c.weather_error;
    } else c.weather_error = out.error;
    save(d.sql, c);
  }

  const next =
    [underway(c, now), nextEvent(c, now)].find((e) => e && placeOf(e) && startOf(e) > now && startOf(e) - now <= TRAVEL_AHEAD_MS) ?? null;
  if (!next) {
    if (c.travel) {
      c.travel = null;
      save(d.sql, c);
    }
    return c;
  }
  const from = h?.fix ? { lat: h.fix.lat, lon: h.fix.lon } : home;
  const t = c.travel;
  const fresh = t && t.event_id === next.id && now - t.at < TRAVEL_MS && from && metres(t.from, from) < 1_000;
  if (fresh || !from) return c;
  const address = placeOf(next)!;
  let to = c.places[address];
  if (to === undefined) {
    // A saved place by that name first, so "Gym" on the calendar needs no lookup.
    const saved = pins(d.sql).find((p) => p.name.toLowerCase() === address.toLowerCase());
    if (saved) to = { lat: saved.lat, lon: saved.lon, name: saved.name };
    else {
      const found = await d.maps.geocode(address, { run_id: d.run_id ?? null, near: from });
      if (!found.ok) {
        c.travel_error = found.error;
        save(d.sql, c);
        return c;
      }
      const best: Found | undefined = found.value[0];
      to = best ? { lat: best.lat, lon: best.lon, name: best.name } : null;
    }
    c.places = { ...c.places, [address]: to };
    // Keep the most recent sixty addresses.
    const keys = Object.keys(c.places);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete c.places[k];
    save(d.sql, c);
  }
  if (!to) {
    c.travel = null;
    c.travel_error = `No map found "${address}", the place on ${next.title}.`;
    save(d.sql, c);
    return c;
  }
  const r = await d.maps.route([from, to], "drive", { run_id: d.run_id ?? null, label: `${h?.fix ? "Here" : "Home"} to ${next.title}` });
  if (!r.ok) {
    c.travel_error = r.error;
    save(d.sql, c);
    return c;
  }
  const start = startOf(next);
  c.travel = {
    event_id: next.id,
    title: next.title,
    start,
    location: address,
    to: { lat: to.lat, lon: to.lon },
    from,
    from_what: h?.fix ? "here" : "home",
    s: r.value.s,
    m: r.value.m,
    traffic: r.value.traffic,
    leave_by: start - (r.value.s + margin(r.value.s, r.value.traffic)) * 1000,
    at: now,
    line: r.value.line,
  };
  delete c.travel_error;
  save(d.sql, c);
  return c;
}

// --- what changed -----------------------------------------------------------------------------------

/** What a look at the situation can notice (§10.4): the trip to the next event, and the weather. The calendar's changes have their own look (core/src/intake.ts). */
export type SituationChange = SenseItem & { source: "situation"; event: "travel" | "weather"; key: string };

/** What kind of weather a line from `whatMatters` is about: rain, heat, wind. */
const weatherKind = (line: string) => line.split(/[ ,]/)[0]!;

/**
 * What changed between two looks: the trip to the next event now needing
 * to start ten minutes sooner or more, and weather that newly matters
 * today. Nothing on the first look, when there's nothing to compare with.
 */
export function changes(before: SituationCache, after: SituationCache, settings: Settings, now = Date.now()): SituationChange[] {
  const tz = zoneOf(settings);
  const out: SituationChange[] = [];
  const t0 = before.travel;
  const t1 = after.travel;
  if (t0 && t1 && t0.event_id === t1.event_id && t1.leave_by <= t0.leave_by - 10 * 60_000)
    out.push({
      source: "situation",
      event: "travel",
      what: `The trip to "${t1.title}" now takes about ${minutes(t1.s)}${t1.traffic ? " with traffic" : ""}: leave by ${clockLocal(new Date(t1.leave_by), tz)}, not ${clockLocal(new Date(t0.leave_by), tz)}`,
      key: `travel:${t1.event_id}:${Math.round(t1.leave_by / 600_000)}`,
      thread: t1.event_id,
    });
  if (before.weather && after.weather && after.weather.at !== before.weather.at) {
    const units = unitsFor(settings.units, tz);
    const had = new Set(whatMatters(before.weather, tz, units, now).map(weatherKind));
    const day = startOfLocalDay(new Date(now), tz).getTime();
    for (const line of whatMatters(after.weather, tz, units, now).filter((l) => !had.has(weatherKind(l))))
      out.push({
        source: "situation",
        event: "weather",
        what: `The forecast changed: ${line}`,
        key: `weather:${weatherKind(line)}:${day}`,
      });
  }
  return out;
}

// --- what a run is told ----------------------------------------------------------------------------

const ago = (ms: number) => (ms < 60_000 ? "just now" : `${minutes(ms / 1000)} ago`);
const forHow = (ms: number) => (ms < 60_000 ? "under a minute" : minutes(ms / 1000));

/**
 * The situation in a few lines, for every prompt's fresh part. Plain and
 * short, with no coordinates: what the owner would see on Now.
 */
export function situationLines(sql: Sql, settings: Settings, now = Date.now()): string {
  const tz = zoneOf(settings);
  const units: Units = unitsFor(settings.units, tz);
  const c = cache(sql);
  const lines: string[] = [];

  // Where.
  if (!settings.location.on) {
    lines.push("Where: unknown. The owner turned location off, so you don't know where they are; say so rather than guess.");
  } else {
    const h = here(sql);
    if (!h.fix) {
      lines.push("Where: unknown. No location has come in yet (OwnTracks isn't set up, or hasn't reported); say so rather than guess.");
    } else {
      const old = now - h.fix.at > STALE_FIX_MS ? ` (from the phone's last report, ${ago(now - h.fix.at)}; it may be out of date)` : "";
      if (h.place) {
        lines.push(`Where: at ${h.place.name}, since ${clockLocal(new Date(h.place.since), tz)} (${forHow(now - h.place.since)})${old}.`);
      } else {
        const home = homePin(sql);
        const n = nearest(pins(sql), h.fix);
        const parts = [
          home ? `${distance(metres(home, h.fix), units)} from Home` : "",
          n && n.pin.id !== home?.id ? `nearest saved place ${n.pin.name}, ${distance(n.m, units)}` : "",
          h.left && now - h.left.at < 6 * 3_600_000 ? `left ${h.left.name} at ${clockLocal(new Date(h.left.at), tz)}` : "",
          h.fix.motion?.includes("automotive") ? "driving" : h.fix.motion?.includes("walking") ? "walking" : "",
        ].filter(Boolean);
        lines.push(`Where: out, not at a saved place${parts.length ? `: ${parts.join("; ")}` : ""}${old}.`);
      }
    }
  }

  // Doing (focus has its own line in the prompt).
  const e = underway(c, now);
  if (e) lines.push(`Doing: in "${e.title}" until ${clockLocal(new Date(endOf(e)), tz)}.`);

  // Next.
  const next = nextEvent(c, now);
  if (next) {
    const t = c.travel && c.travel.event_id === next.id ? c.travel : null;
    const trip = t
      ? ` About ${minutes(t.s)} by car from ${t.from_what === "here" ? "where they are" : "home"}${t.traffic ? " with traffic" : " (no live traffic)"}, worked out ${ago(now - t.at)}: leave by ${clockLocal(new Date(t.leave_by), tz)}.`
      : placeOf(next) && c.travel_error
        ? ` Travel time unknown: ${c.travel_error}`
        : "";
    lines.push(
      `Next: "${next.title}" at ${clockLocal(new Date(startOf(next)), tz)}${placeOf(next) ? `, at ${placeOf(next)}` : ""}.${trip}`,
    );
  } else if (c.events_error) {
    lines.push(`Next: the calendar couldn't be read (${c.events_error}).`);
  } else if (c.events_at) {
    lines.push("Next: nothing more on the calendar today.");
  }

  // Weather.
  if (c.weather && now - c.weather.at < 3 * WEATHER_MS) {
    lines.push(`Weather near them (Open-Meteo, ${shortLocal(new Date(c.weather.at), tz)}): ${weatherLine(c.weather, tz, units, now)}.`);
  } else if (c.weather_error) {
    lines.push(`Weather: unknown (${c.weather_error}).`);
  }

  // Devices.
  const h = here(sql);
  if (settings.location.on && h.fix && (h.fix.batt != null || h.fix.conn)) {
    const phone = [
      h.fix.batt != null ? `battery ${h.fix.batt}%${h.fix.charging ? ", charging" : ""}` : "",
      h.fix.conn === "wifi" ? "on Wi-Fi" : h.fix.conn === "mobile" ? "on mobile data" : "",
    ].filter(Boolean);
    lines.push(`Devices: phone ${phone.join(", ")} (as of ${clockLocal(new Date(h.fix.at), tz)}).`);
  }

  return lines.length
    ? `The situation, rebuilt from what the phone, calendar and weather last said. It's newer than anything said earlier in the conversation: where the owner is now comes from here, not from where they said they were before. Don't look up what's here; say how old it is when it matters, and since when they've been somewhere when you say where:\n${lines.map((l) => `- ${l}`).join("\n")}`
    : "";
}

/** Whether the weather is worth a mention today (for Now). */
export function weatherMatters(sql: Sql, settings: Settings, now = Date.now()): string[] {
  const c = cache(sql);
  const tz = zoneOf(settings);
  return c.weather ? whatMatters(c.weather, tz, unitsFor(settings.units, tz), now) : [];
}

export type { Travel };

// --- the views ------------------------------------------------------------------------------------

/** The situation as its view and Now show it: the same parts as the prompt's lines, as data. */
export function situationPage(sql: Sql, settings: Settings, now = Date.now(), devices: SituationPage["devices"] = []): SituationPage {
  const tz = zoneOf(settings);
  const units = unitsFor(settings.units, tz);
  const c = cache(sql);
  const h = here(sql);
  let where: SituationPage["where"];
  if (!settings.location.on) where = { known: false, why: "Location is off." };
  else if (!h.fix) where = { known: false, why: "No location yet. Set up OwnTracks in Settings → Devices." };
  else {
    const home = homePin(sql);
    const n = nearest(pins(sql), h.fix);
    where = {
      known: true,
      place: h.place ? { name: h.place.name, since: h.place.since } : null,
      away: h.place
        ? null
        : {
            home_m: home ? Math.round(metres(home, h.fix)) : null,
            nearest: n && n.pin.id !== home?.id ? { name: n.pin.name, m: Math.round(n.m) } : null,
            left: h.left && now - h.left.at < 6 * 3_600_000 ? { name: h.left.name, at: h.left.at } : null,
          },
      fix_at: h.fix.at,
      motion: h.fix.motion?.includes("automotive") ? "driving" : h.fix.motion?.includes("walking") ? "walking" : null,
      point: { lat: h.fix.lat, lon: h.fix.lon },
    };
  }
  const e = underway(c, now);
  const n = nextEvent(c, now);
  const t = n && c.travel?.event_id === n.id ? c.travel : null;
  const phone =
    settings.location.on && h.fix && (h.fix.batt != null || h.fix.conn)
      ? [
          {
            name: "Phone",
            state: [
              h.fix.batt != null ? `${h.fix.batt}%${h.fix.charging ? ", charging" : ""}` : "",
              h.fix.conn === "wifi" ? "Wi-Fi" : h.fix.conn === "mobile" ? "mobile data" : "",
            ]
              .filter(Boolean)
              .join(", "),
            online: now - h.fix.at < STALE_FIX_MS,
          },
        ]
      : [];
  return {
    kind: "situation",
    where,
    doing: e ? { title: e.title, until: endOf(e) } : null,
    focus: focusNow(sql, now),
    next: n
      ? {
          title: n.title,
          start: startOf(n),
          location: placeOf(n),
          travel: t ? { s: t.s, traffic: t.traffic, leave_by: t.leave_by, from: t.from_what, at: t.at } : null,
          travel_error: placeOf(n) && !t ? (c.travel_error ?? null) : null,
        }
      : null,
    calendar_error: c.events_error ?? null,
    weather:
      c.weather && now - c.weather.at < 3 * WEATHER_MS
        ? { line: weatherLine(c.weather, tz, units, now), matters: whatMatters(c.weather, tz, units, now), at: c.weather.at }
        : null,
    devices: [
      ...phone,
      ...nodes(sql).map((n) => ({
        name: n.name,
        state: Object.values(n.state)
          .map((v) => String(v))
          .join(", "),
        online: n.online,
      })),
      ...devices,
    ],
    tasks: openTasks(sql)
      .map(taskView)
      .filter((t) => t.fits)
      .map((t) => ({ id: t.id, title: t.title, fits: t.fits! })),
    units,
    credit: MAPS[settings.maps.provider].credit,
  };
}

export function weatherPage(sql: Sql, settings: Settings, now = Date.now()): WeatherPage {
  const tz = zoneOf(settings);
  const units = unitsFor(settings.units, tz);
  const c = cache(sql);
  return {
    kind: "weather",
    weather: c.weather,
    units,
    tz,
    matters: c.weather ? whatMatters(c.weather, tz, units, now) : [],
    ...(c.weather
      ? {}
      : {
          error:
            c.weather_error ??
            "Atlas hasn't looked at the weather yet: it needs to know roughly where you are (location, or a pinned Home).",
        }),
  };
}
