// The calendar sense, as the reminders and calendar tools see it. Which
// calendar answers is an extension (VISION §17): iCloud over CalDAV by
// default, Google or others behind this same interface.

export type { CalendarEvent, EventPerson } from "../../../extensions/sdk";
import type { CalendarEvent, EventPerson } from "../../../extensions/sdk";

/** A person on an event as one line: "Doug Henderson <doug@acme.com>", or whichever of the two the invite has. */
export const personText = (p: EventPerson): string => (p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? ""));

export interface CalendarRange {
  start: Date;
  end: Date;
}

export interface CalendarCheck {
  calendars?: string[];
  /** Events found from today through the next 30 days, across visible calendars. */
  events_next_30_days?: number;
  /** What the provider said about itself, when it says it in words. */
  text?: string;
}

export interface CalendarSource {
  /** Events overlapping the range, sorted by start, recurring events expanded. Asks the provider when what it holds is old. */
  list(range: CalendarRange): Promise<CalendarEvent[]>;
  /** What it already holds for the range, without asking the provider, and when that was current. Null if it holds nothing for it. */
  held?(range: CalendarRange): Promise<{ events: CalendarEvent[]; as_of: number } | null>;
  /** A live check for Settings: signs in and counts what it found. */
  check(): Promise<CalendarCheck>;
  /** Moves an event to a new start and end; what it was before, and after. Absent when the provider can't change events. */
  move?(id: string, to: { start: string; end: string }): Promise<{ before: CalendarEvent; event: CalendarEvent }>;
}

/** What a read gives the tools and the app: the events, and, when the provider couldn't be asked, how old they are and why. */
export interface CalendarRead {
  events: CalendarEvent[];
  stale?: { as_of: number; why: string };
  /** Calendars that couldn't be read at all, each with why, while the others could. */
  missing?: string[];
}

/** The calendar as runs and the app see it: reads that fall back to what's held when the provider can't be asked. */
export interface Calendar {
  read(range: CalendarRange): Promise<CalendarRead>;
  check(): Promise<CalendarCheck>;
  move?(id: string, to: { start: string; end: string }): Promise<{ before: CalendarEvent; event: CalendarEvent }>;
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
