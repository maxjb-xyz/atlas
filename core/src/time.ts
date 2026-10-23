// Time in the owner's one resolved time zone (§23.6). Server time is never
// used as the owner's time: everything shown or parsed goes through these.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The owner's one resolved time zone (§23.6), or UTC until one is set. */
export function zoneOf(settings: { timezone: string }): string {
  return settings.timezone && isValidZone(settings.timezone) ? settings.timezone : "UTC";
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday ?? "",
  };
}

/** The zone's offset from UTC at that instant, in ms (New York in summer is -4 h). */
export function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A wall-clock time in the zone to the instant it names. DST gaps move forward, like a clock does. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  const fits = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
  };
  if (fits(first) && fits(second)) return new Date(Math.min(first, second)); // a repeated hour: the first one
  if (fits(second)) return new Date(second);
  if (fits(first)) return new Date(first);
  // In a spring-forward gap: read it with the offset from before the change, like a clock moving on.
  return new Date(Math.max(first, second));
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function offsetText(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const m = Math.abs(Math.round(ms / 60_000));
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "2026-10-22T10:00:00-04:00": what tools hand the model. */
export function isoLocal(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetText(offsetMs(date, tz))}`;
}

export function localDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "Thu Oct 22, 10:00": what receipts show. */
export function shortLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** "2:35 PM": a time of day in the owner's zone. */
export function clockLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Wednesday, October 21, 2026, 4:05 PM": the fresh block's "now". */
export function longLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(date);
}

export function startOfLocalDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, 0, tz);
}

/** Adds whole local days, keeping the wall-clock time (so DST days still start at midnight). */
export function addLocalDays(date: Date, days: number, tz: string): Date {
  const p = zonedParts(date, tz);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), p.hour, p.minute, p.second, tz);
}

/**
 * Reads a time the model wrote. An explicit offset or Z is taken as is; a
 * bare "2026-10-22T10:00" or "2026-10-22" is wall-clock time in the owner's zone.
 */
export function parseWhen(text: string, tz: string): Date | null {
  const s = text.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  if (m[7]) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  return zonedToUtc(y, mo, d, h, mi, sec, tz);
}

/**
 * When the quiet hours `from` to `to` (local HH:mm, which may run past
 * midnight) end, if `now` is inside them; otherwise null.
 */
export function quietUntil(now: Date, tz: string, quiet: { on: boolean; from: string; to: string }): Date | null {
  if (!quiet.on || quiet.from === quiet.to) return null;
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const p = zonedParts(now, tz);
  const at = p.hour * 60 + p.minute;
  const from = mins(quiet.from);
  const to = mins(quiet.to);
  const inside = from < to ? at >= from && at < to : at >= from || at < to;
  if (!inside) return null;
  // The end is today at `to`, or tomorrow when the hours run past midnight and it's still evening.
  const end = zonedToUtc(p.year, p.month, p.day, Math.floor(to / 60), to % 60, 0, tz);
  return at < to ? end : addLocalDays(end, 1, tz);
}
