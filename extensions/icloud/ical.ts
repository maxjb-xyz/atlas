// A small iCalendar (RFC 5545) reader for the VEVENTs CalDAV returns. The
// server expands recurrences for us (calendar-query with <C:expand>), so
// there is no RRULE logic here; a master event that still carries an RRULE
// only yields its first occurrence.

import { isValidZone, zonedToUtc as wallToUtc } from "../lib/time";
import type { CalendarEvent, EventPerson } from "./types";

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

type When = { kind: "date"; date: string } | { kind: "time"; ms: number };

const DAY_MS = 86_400_000;

/** Joins folded lines: a line break followed by one space or tab continues the line. */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.length > 0);
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Splits "NAME;P1=a;P2=\"b:c\":value" at the first colon outside quotes. */
export function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value: line.slice(colon + 1) };
}

// --- time ------------------------------------------------------------------

/**
 * An IANA zone for a TZID. Some clients send path-like ids such as
 * "/mozilla.org/20050126_1/America/New_York"; the tail is tried too.
 */
export function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const segments = tzid.replace(/^"|"$/g, "").split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/");
    if (isValidZone(candidate)) return candidate;
  }
  return null;
}

/** The UTC instant of a wall-clock time (given as if it were UTC) in `tz`. */
export function zonedToUtc(wall: number, tz: string): number {
  const d = new Date(wall);
  return wallToUtc(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    tz,
  ).getTime();
}

function parseWhen(prop: Prop, floatingTz: string | null): When | null {
  const v = prop.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || prop.params.VALUE === "DATE") {
    if (!date) return null;
    return { kind: "date", date: `${date[1]}-${date[2]}-${date[3]}` };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return null;
  const wall = Date.UTC(+t[1]!, +t[2]! - 1, +t[3]!, +t[4]!, +t[5]!, +t[6]!);
  if (t[7] === "Z") return { kind: "time", ms: wall };
  const zone = resolveZone(prop.params.TZID) ?? floatingTz;
  return { kind: "time", ms: zone ? zonedToUtc(wall, zone) : wall };
}

/** RFC 5545 DURATION in milliseconds ("P1D", "PT1H30M", "P2W"). Sign is ignored. */
export function parseDuration(v: string): number | null {
  const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim().replace(/^[+-]/, "") === "P") return null;
  const [w, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  return ((((w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function token(w: When): string {
  if (w.kind === "date") return w.date.replace(/-/g, "");
  return new Date(w.ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

// --- events ----------------------------------------------------------------

/**
 * The VEVENTs in `ics`, as calendar events on `calendar`. Floating times
 * (no zone) are read in `floatingTz` when given, else as UTC. Cancelled
 * events are dropped.
 */
export function parseEvents(ics: string, calendar: string, floatingTz?: string): CalendarEvent[] {
  const floating = floatingTz ? resolveZone(floatingTz) : null;
  const out: CalendarEvent[] = [];
  const stack: string[] = [];
  let props: Prop[] | null = null;
  for (const line of unfold(ics)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (stack[stack.length - 1] === "VEVENT") props = [];
      continue;
    }
    if (p.name === "END") {
      const ended = stack.pop();
      if (ended === "VEVENT" && props) {
        const ev = toEvent(props, calendar, floating);
        if (ev) out.push(ev);
        props = null;
      }
      continue;
    }
    // Only the VEVENT's own properties, not those of a nested VALARM.
    if (props && stack[stack.length - 1] === "VEVENT") props.push(p);
  }
  return out;
}

function toEvent(props: Prop[], calendar: string, floating: string | null): CalendarEvent | null {
  const one = (name: string) => props.find((p) => p.name === name);
  if ((one("STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED") return null;
  const dtstart = one("DTSTART");
  const start = dtstart ? parseWhen(dtstart, floating) : null;
  if (!start) return null;

  const dtend = one("DTEND");
  let end = dtend ? parseWhen(dtend, floating) : null;
  if (end && end.kind !== start.kind) end = null; // mismatched kinds: use the default below
  if (!end) {
    const dur = one("DURATION");
    const ms = dur ? parseDuration(dur.value) : null;
    if (start.kind === "date") end = { kind: "date", date: addDays(start.date, ms ? Math.max(1, Math.round(ms / DAY_MS)) : 1) };
    else end = { kind: "time", ms: start.ms + (ms ?? 0) };
  }
  // An end before the start is a broken event; show it as a point in time (or one day).
  if (start.kind === "date" && end.kind === "date" && end.date <= start.date) end = { kind: "date", date: addDays(start.date, 1) };
  if (start.kind === "time" && end.kind === "time" && end.ms < start.ms) end = { kind: "time", ms: start.ms };

  const uid = one("UID")?.value.trim() || `${calendar}:${token(start)}`;
  const rid = one("RECURRENCE-ID");
  const ridWhen = rid ? parseWhen(rid, floating) : null;
  const text = (name: string) => {
    const v = one(name)?.value;
    return v === undefined ? undefined : unescapeText(v).trim() || undefined;
  };
  const iso = (w: When) => (w.kind === "date" ? w.date : new Date(w.ms).toISOString());

  const ev: CalendarEvent = {
    id: ridWhen ? `${uid}::${token(ridWhen)}` : uid,
    calendar,
    title: text("SUMMARY") ?? "(no title)",
    start: iso(start),
    end: iso(end),
    all_day: start.kind === "date",
  };
  const location = text("LOCATION");
  const notes = text("DESCRIPTION");
  if (location) ev.location = location;
  if (notes) ev.notes = notes;
  const people = peopleOf(props);
  if (people.length) ev.people = people;
  return ev;
}

/** The organizer and the attendees, once each, leaving out rooms and other resources. */
function peopleOf(props: Prop[]): EventPerson[] {
  const out: EventPerson[] = [];
  for (const p of props) {
    if (p.name !== "ORGANIZER" && p.name !== "ATTENDEE") continue;
    const cutype = (p.params.CUTYPE ?? "INDIVIDUAL").toUpperCase();
    if (cutype !== "INDIVIDUAL" && cutype !== "GROUP" && cutype !== "UNKNOWN") continue;
    const address = /^mailto:(.+)$/i.exec(p.value.trim())?.[1] ?? p.params.EMAIL;
    const email = address && /^[^@\s]+@[^@\s]+$/.test(address.trim()) ? address.trim().toLowerCase() : undefined;
    const name = p.params.CN ? unescapeText(p.params.CN).trim() || undefined : undefined;
    if (!email && !name) continue;
    const same = out.find((o) => (email && o.email === email) || (!email && name && o.name === name));
    if (same) {
      if (!same.name && name) same.name = name;
      continue;
    }
    out.push({ ...(name && name.toLowerCase() !== email ? { name } : {}), ...(email ? { email } : {}) });
    if (out.length >= 30) break;
  }
  return out;
}

// --- changing an event -----------------------------------------------------

/** One content line folded at 75 octets, as RFC 5545 asks (counted in characters here, which only folds earlier). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}

/** A start or end as an iCalendar property: a date for an all-day event, else a UTC time. */
function whenLine(name: "DTSTART" | "DTEND", v: string, allDay: boolean): string {
  if (allDay) return `${name};VALUE=DATE:${v.slice(0, 10).replace(/-/g, "")}`;
  return `${name}:${token({ kind: "time", ms: Date.parse(v) })}`;
}

/**
 * The calendar object `ics` with the event `uid` at a new time: its start
 * and end replaced (a DURATION gives way to an end), its SEQUENCE one more
 * and its DTSTAMP now, as a calendar app does when you drag an event.
 * "repeats" when it's a repeating event, which Atlas doesn't move one
 * occurrence of; null when the object doesn't hold that event.
 */
export function moveIn(
  ics: string,
  uid: string,
  to: { start: string; end: string; all_day: boolean },
  now = Date.now(),
): string | "repeats" | null {
  const out: string[] = [];
  const stack: string[] = [];
  /** The VEVENT being read: its lines, and which of them are its own properties (not a nested alarm's). */
  let block: Array<{ line: string; own: boolean }> | null = null;
  let found = false;
  for (const line of unfold(ics)) {
    const p = parseLine(line);
    if (p?.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (stack.length === 2 && stack[1] === "VEVENT") block = [];
    }
    if (!block) {
      if (p?.name === "END") stack.pop();
      out.push(line);
      continue;
    }
    const own = stack.length === 2 && p?.name !== "BEGIN" && p?.name !== "END";
    block.push({ line, own });
    if (p?.name !== "END") continue;
    stack.pop();
    if (stack.length !== 1) continue;
    // The VEVENT ended: keep it as it was, or move it.
    const props = block.map((b) => (b.own ? parseLine(b.line) : null));
    if (!props.some((q) => q?.name === "UID" && q.value.trim() === uid)) {
      out.push(...block.map((b) => b.line));
      block = null;
      continue;
    }
    if (props.some((q) => q?.name === "RRULE" || q?.name === "RDATE" || q?.name === "RECURRENCE-ID")) return "repeats";
    found = true;
    let seq = 0;
    const kept: string[] = [];
    for (const [i, b] of block.entries()) {
      const q = props[i];
      if (q?.name === "SEQUENCE") seq = Number(q.value) || 0;
      if (q && ["DTSTART", "DTEND", "DURATION", "DTSTAMP", "SEQUENCE"].includes(q.name)) continue;
      kept.push(b.line);
      if (q?.name === "UID")
        kept.push(
          `DTSTAMP:${token({ kind: "time", ms: now })}`,
          whenLine("DTSTART", to.start, to.all_day),
          whenLine("DTEND", to.end, to.all_day),
          `SEQUENCE:${seq + 1}`,
        );
    }
    // SEQUENCE may come after UID: put the new one where the old count is known.
    const at = kept.findIndex((l) => l.startsWith("SEQUENCE:"));
    if (at >= 0) kept[at] = `SEQUENCE:${seq + 1}`;
    out.push(...kept);
    block = null;
  }
  return found ? `${out.map(fold).join("\r\n")}\r\n` : null;
}
