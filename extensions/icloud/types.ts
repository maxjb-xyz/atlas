// What the iCloud extension's CalDAV reader works with.

import { Failure, type CalendarEvent } from "../sdk";

export type { CalendarEvent, EventPerson } from "../sdk";

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
  list(range: CalendarRange): Promise<CalendarEvent[]>;
  held?(range: CalendarRange): { events: CalendarEvent[]; as_of: number } | null;
  check(): Promise<CalendarCheck>;
  move?(id: string, to: { start: string; end: string }): Promise<{ before: CalendarEvent; event: CalendarEvent }>;
}

export interface ICloudCredentials {
  /** The Apple ID email. */
  username: string;
  /** An app-specific password from account.apple.com, never the account password. */
  app_password: string;
}

/** Thrown with a plain reason the owner can act on. "auth" makes the core wait before trying again, so the account isn't locked. */
export class CalendarError extends Failure {
  constructor(message: string, code: "auth" | "network" | "protocol") {
    super(message, code);
  }
}
