// iCloud (VISION §10.1, §7.1): the owner's calendar over CalDAV and their
// contacts over CardDAV, with their Apple ID and an app-specific password.
// Atlas reads both, and moves an event when the owner's words call for it. Every request to iCloud carries the sign-in, so each counts as
// one: the calendar is kept as a copy (the extension's state) and only
// calendars that changed are read again. A refusal comes back as an "auth"
// failure, and the core waits before trying again so the account isn't locked.

import { type CalendarEvent, type Extension, Failure, http } from "../sdk";
import { type CalendarCopy, icloudCalendar } from "./caldav";
import { icloudVCards } from "./carddav";

const source = (ctx: Parameters<NonNullable<Extension["calendar"]>>[0], hidden: string[], keep: (c: CalendarCopy | null) => void) => {
  const username = (ctx.settings.username ?? "").trim();
  if (!username) throw new Failure("iCloud needs your Apple ID (the email you sign in to iCloud with).", "auth");
  return icloudCalendar(
    { username, app_password: "" },
    {
      auth: ctx.basic(username, "app_password"),
      hidden,
      timezone: ctx.tz,
      fetch: http,
      store: { load: () => (ctx.state as unknown as CalendarCopy | null) ?? null, save: keep },
    },
  );
};

const ext: Extension = {
  manifest: {
    id: "icloud",
    name: "iCloud",
    version: "1.1.0",
    about:
      "Your iCloud calendar and contacts, read with your Apple ID and an app-specific password. Atlas reads them, and moves an event when you ask, with Undo.",
    provides: ["calendar", "contacts"],
    hosts: ["icloud.com"],
    settings: [{ name: "username", label: "Apple ID", help: "The email you sign in to iCloud with." }],
    secrets: [
      {
        name: "app_password",
        label: "App-specific password",
        help: "Make one at account.apple.com → Sign-In and Security → App-Specific Passwords. It looks like xxxx-xxxx-xxxx-xxxx. Your Apple ID's own password won't work.",
      },
    ],
  },
  async calendar(ctx, r) {
    let state: CalendarCopy | null | undefined;
    const cal = source(ctx, r.hidden, (c) => (state = c));
    const range = { start: new Date(r.start), end: new Date(r.end) };
    if (r.held) {
      const held = cal.held?.(range) ?? null;
      return { events: held?.events ?? [], ...(held ? { as_of: held.as_of } : {}) };
    }
    const events: CalendarEvent[] = await cal.list(range);
    return { events, ...(state !== undefined ? { state: state as never } : {}) };
  },
  async move(ctx, m) {
    let state: CalendarCopy | null | undefined;
    const cal = source(ctx, [], (c) => (state = c));
    const out = await cal.move!(m.id, { start: m.start, end: m.end });
    return { ...out, ...(state !== undefined ? { state: state as never } : {}) };
  },
  async test(ctx) {
    let state: CalendarCopy | null | undefined;
    const c = await source(ctx, [], (x) => (state = x)).check();
    return {
      text: `iCloud signed in as ${ctx.settings.username}: ${c.calendars.length} calendar${c.calendars.length === 1 ? "" : "s"} (${c.calendars.join(", ")}), ${c.events_next_30_days} event${c.events_next_30_days === 1 ? "" : "s"} in the next 30 days.`,
      owner: { emails: [ctx.settings.username ?? ""].filter((e) => e.includes("@")) },
      ...(state !== undefined ? { state: state as never } : {}),
    };
  },
  async contacts(ctx) {
    const username = (ctx.settings.username ?? "").trim();
    if (!username) throw new Failure("iCloud needs your Apple ID first.", "auth");
    return { vcards: (await icloudVCards(ctx.basic(username, "app_password"), http)).join("\n") };
  },
};

export default ext;
