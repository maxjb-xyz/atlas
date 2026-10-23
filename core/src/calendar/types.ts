// The calendar sense, as the reminders and calendar tools see it. M0 has one
// adapter, iCloud over CalDAV (caldav.ts). Google and others come later
// behind this same interface.

export interface CalendarEvent {
  /** Stable for one occurrence: the event UID, plus the RECURRENCE-ID for repeats. */
  id: string;
  calendar: string;
  title: string;
  /** UTC ISO time ("2026-10-22T14:00:00.000Z"), or a plain date ("2026-10-22") when all_day. */
  start: string;
  /** Exclusive end, in the same form as `start`. */
  end: string;
  all_day: boolean;
  location?: string;
  notes?: string;
  /** Who it's with: the organizer and those invited, as the invite names them (not rooms or other resources). */
  people?: EventPerson[];
}

export interface EventPerson {
  name?: string;
  email?: string;
}

/** A person on an event as one line: "Doug Henderson <doug@acme.com>", or whichever of the two the invite has. */
export const personText = (p: EventPerson): string => (p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? ""));

export interface CalendarRange {
  start: Date;
  end: Date;
}

export interface CalendarCheck {
  calendars: string[];
  /** Events found from today through the next 30 days, across visible calendars. */
  events_next_30_days: number;
}

export interface CalendarSource {
  /** Events overlapping the range, sorted by start, recurring events expanded. Asks the provider when what it holds is old. */
  list(range: CalendarRange): Promise<CalendarEvent[]>;
  /** What it already holds for the range, without asking the provider, and when that was current. Null if it holds nothing for it. */
  held?(range: CalendarRange): { events: CalendarEvent[]; as_of: number } | null;
  /** A live check for Settings: signs in and counts what it found. */
  check(): Promise<CalendarCheck>;
}

/** What a read gives the tools and the app: the events, and, when the provider couldn't be asked, how old they are and why. */
export interface CalendarRead {
  events: CalendarEvent[];
  stale?: { as_of: number; why: string };
}

/** The calendar as runs and the app see it: reads that fall back to what's held when the provider can't be asked. */
export interface Calendar {
  read(range: CalendarRange): Promise<CalendarRead>;
  check(): Promise<CalendarCheck>;
}

export interface ICloudCredentials {
  /** The Apple ID email. */
  username: string;
  /** An app-specific password from account.apple.com, never the account password. */
  app_password: string;
}

/** Thrown with a plain reason the owner can act on (§22: no dead ends). */
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "network" | "protocol",
  ) {
    super(message);
  }
}
