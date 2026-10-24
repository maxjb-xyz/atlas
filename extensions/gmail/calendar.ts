// Google Calendar, under the same Google sign-in as Gmail (§10.1, §17): one
// setup for both. Every calendar the account shows is read, recurring events
// as their occurrences, and Atlas keeps a copy of the last read so it can
// answer from it when Google can't be asked. A sign-in made before the
// calendar was part of it says to sign in again, rather than failing quietly.

import { type CalendarEvent, type EventPerson, Failure, get, http, json } from "../sdk";

const API = "https://www.googleapis.com/calendar/v3";
/** At most this many calendars, and events from each, in one read. */
const MAX_CALENDARS = 12;
const MAX_EVENTS = 250;
/** What the copy keeps: the last read's range and events. */
const MAX_KEPT = 400;

export interface CalendarCopy {
  as_of: number;
  start: string;
  end: string;
  events: CalendarEvent[];
}

interface GTime {
  dateTime?: string;
  date?: string;
}
interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  recurringEventId?: string;
  start?: GTime;
  end?: GTime;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; resource?: boolean }>;
}

type Auth = { secret(n: string): string };
const auth = (ctx: Auth) => ({ authorization: `Bearer ${ctx.secret("access_token")}` });

/** Google's answer, read as JSON; a sign-in without the calendar in it says so in words the owner can act on. */
async function read<T>(res: Response): Promise<T> {
  if (res.status === 403) {
    const text = await res.clone().text();
    if (/insufficient|scope/i.test(text))
      throw new Failure(
        "Google Calendar isn't part of this Google sign-in yet: sign in to Google again in Abilities → Services, and allow the calendar.",
        "protocol",
        403,
      );
  }
  return json<T>(res, "Google Calendar");
}

/**
 * An occurrence's id: its series first (the recurring event's id, or its own),
 * then its own id, then its calendar, so a move knows where it lives and the
 * series reads as one ("series::event::calendar").
 */
export const eventId = (calendar: string, e: GEvent) => `${e.recurringEventId ?? e.id}::${e.id}::${calendar}`;
const parts = (id: string) => {
  const [, event, ...cal] = id.split("::");
  if (!event || !cal.length) throw new Failure(`"${id}" isn't one of Google Calendar's events.`, "protocol");
  return { event, calendar: cal.join("::") };
};

function eventOf(calendar: { id: string; name: string }, e: GEvent): CalendarEvent | null {
  if (e.status === "cancelled" || !e.start || !e.end) return null;
  const all_day = !!e.start.date && !e.start.dateTime;
  const at = (t: GTime) => (all_day ? t.date! : new Date(t.dateTime!).toISOString());
  const people: EventPerson[] = [
    ...(e.organizer && !e.organizer.self ? [{ name: e.organizer.displayName, email: e.organizer.email }] : []),
    ...(e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => ({ name: a.displayName, email: a.email })),
  ].map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v)) as EventPerson);
  return {
    id: eventId(calendar.id, e),
    calendar: calendar.name,
    title: e.summary?.trim() || "(no title)",
    start: at(e.start),
    end: at(e.end),
    all_day,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { notes: e.description.slice(0, 2_000) } : {}),
    ...(people.length ? { people: people.slice(0, 30) } : {}),
  };
}

/** The account's calendars, by id and the name the owner sees, without the ones they leave out. */
export async function calendars(ctx: Auth, hidden: string[] = []): Promise<Array<{ id: string; name: string }>> {
  const out = await read<{ items?: Array<{ id: string; summary?: string; summaryOverride?: string; hidden?: boolean }> }>(
    await get(`${API}/users/me/calendarList?maxResults=50`, { headers: auth(ctx) }),
  );
  const leave = new Set(hidden.map((h) => h.trim().toLowerCase()));
  return (out.items ?? [])
    .filter((c) => !c.hidden)
    .map((c) => ({ id: c.id, name: (c.summaryOverride ?? c.summary ?? c.id).trim() }))
    .filter((c) => !leave.has(c.name.toLowerCase()))
    .slice(0, MAX_CALENDARS);
}

/** Every event overlapping the range, across the account's calendars, in order. */
export async function listEvents(ctx: Auth, r: { start: string; end: string; hidden: string[] }): Promise<CalendarEvent[]> {
  const all: CalendarEvent[] = [];
  for (const c of await calendars(ctx, r.hidden)) {
    const q = new URLSearchParams({
      timeMin: new Date(r.start).toISOString(),
      timeMax: new Date(r.end).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
    });
    const out = await read<{ items?: GEvent[] }>(
      await get(`${API}/calendars/${encodeURIComponent(c.id)}/events?${q}`, { headers: auth(ctx) }),
    );
    for (const e of out.items ?? []) {
      const ev = eventOf(c, e);
      if (ev) all.push(ev);
    }
  }
  const ms = (e: CalendarEvent) => new Date(e.all_day ? `${e.start}T00:00` : e.start).getTime();
  return all.sort((a, b) => ms(a) - ms(b));
}

/** The copy's events for a range it covers, else nothing. */
export function heldEvents(copy: CalendarCopy | undefined, r: { start: string; end: string }): CalendarCopy | null {
  if (!copy || new Date(copy.start) > new Date(r.start) || new Date(copy.end) < new Date(r.end)) return null;
  const start = new Date(r.start).getTime();
  const end = new Date(r.end).getTime();
  const at = (s: string, allDay: boolean) => new Date(allDay ? `${s}T00:00` : s).getTime();
  return { ...copy, events: copy.events.filter((e) => at(e.end, e.all_day) > start && at(e.start, e.all_day) < end) };
}

/** What to keep of a read. */
export const keep = (r: { start: string; end: string }, events: CalendarEvent[]): CalendarCopy => ({
  as_of: Date.now(),
  start: r.start,
  end: r.end,
  events: events.slice(0, MAX_KEPT),
});

/** Moves one occurrence; what it was, and what it is now. */
export async function moveEvent(
  ctx: Auth,
  m: { id: string; start: string; end: string },
): Promise<{ before: CalendarEvent; event: CalendarEvent }> {
  const { event, calendar } = parts(m.id);
  const base = `${API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(event)}`;
  const names = await calendars(ctx);
  const cal = { id: calendar, name: names.find((c) => c.id === calendar)?.name ?? calendar };
  const was = await read<GEvent>(await get(base, { headers: auth(ctx) }));
  const before = eventOf(cal, was);
  if (!before) throw new Failure("That event was cancelled.", "protocol");
  const allDay = !m.start.includes("T");
  const res = await http(base, {
    method: "PATCH",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify(
      allDay ? { start: { date: m.start }, end: { date: m.end } } : { start: { dateTime: m.start }, end: { dateTime: m.end } },
    ),
  });
  const now = eventOf(cal, await read<GEvent>(res));
  if (!now) throw new Failure("Google Calendar didn't say where the event is now.", "protocol");
  return { before, event: now };
}
