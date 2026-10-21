// iCloud Calendar over CalDAV (RFC 4791), read only. Discovery goes
// principal -> calendar home -> calendars. iCloud lists everything from
// caldav.icloud.com but serves the home from a pNN-caldav.icloud.com host,
// so every href is resolved against the URL that returned it. The server
// expands recurring events, so each instance arrives as its own VEVENT
// (identified by UID plus RECURRENCE-ID).

import { parseEvents } from "./ical";
import {
  CalendarError,
  type CalendarCheck,
  type CalendarEvent,
  type CalendarRange,
  type CalendarSource,
  type ICloudCredentials,
} from "./types";
import { type DavResponse, find, findAll, multistatus, textOf, type XmlNode } from "./xml";

export const ICLOUD_CALDAV = "https://caldav.icloud.com/";
/** Per request. A stuck iCloud must not hang a voice turn. */
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const DAY_MS = 86_400_000;

export interface CalDavOptions {
  fetch?: typeof fetch;
  /** Calendar display names to leave out (case and surrounding spaces ignored). */
  hidden?: string[];
  baseUrl?: string;
  /** The owner's zone, for the rare floating (zone-less) event time. Defaults to UTC. */
  timezone?: string;
}

interface DavCalendar {
  url: string;
  name: string;
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`;

/** "20261022T140000Z", the CalDAV time-range form. */
export function davTime(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function calendarQuery(range: CalendarRange): string {
  const s = davTime(range.start);
  const e = davTime(range.end);
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
}

function basicAuth(creds: ICloudCredentials): string {
  const bytes = new TextEncoder().encode(`${creds.username}:${creds.app_password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

const AUTH_REASON =
  "iCloud didn't accept the Apple ID and app-specific password. Make a new app-specific password at account.apple.com (Sign-In and Security) and paste it in Settings. Your normal Apple ID password won't work here.";

class CalDavClient {
  #fetch: typeof fetch;
  #auth: string;

  constructor(creds: ICloudCredentials, fetchFn: typeof fetch) {
    // Called as a plain function: the Workers runtime's fetch throws "Illegal invocation" if called as a method of another object.
    this.#fetch = (input, init) => fetchFn(input, init);
    this.#auth = basicAuth(creds);
  }

  /** One WebDAV request, following redirects by hand so the auth header survives a host change. */
  async request(method: string, url: string, body: string, depth: "0" | "1"): Promise<{ url: string; xml: string }> {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: Response;
      try {
        res = await this.#fetch(target, {
          method,
          headers: {
            Authorization: this.#auth,
            "Content-Type": "application/xml; charset=utf-8",
            Depth: depth,
            Accept: "application/xml, text/xml",
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        // Keep the runtime's own reason (and where it happened) so the owner sees the real cause.
        const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(JSON.stringify({ event: "caldav.fetch_failed", method, host: new URL(target).host, why }));
        throw new CalendarError(
          timedOut
            ? "iCloud Calendar didn't answer in time. Try again in a minute."
            : `Couldn't reach iCloud Calendar at ${new URL(target).host} (${why}).`,
          "network",
        );
      }
      if (res.status === 401 || res.status === 403) throw new CalendarError(AUTH_REASON, "auth");
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("Location");
        if (!location) break;
        target = new URL(location, target).toString();
        continue;
      }
      if (res.status >= 500)
        throw new CalendarError(`iCloud Calendar had a problem on its side (HTTP ${res.status}). Try again soon.`, "network");
      if (res.status !== 207 && res.status !== 200) {
        throw new CalendarError(`iCloud Calendar answered in a way Atlas didn't expect (HTTP ${res.status}).`, "protocol");
      }
      return { url: target, xml: await res.text() };
    }
    throw new CalendarError("iCloud Calendar redirected too many times.", "protocol");
  }

  async multistatus(method: string, url: string, body: string, depth: "0" | "1"): Promise<{ url: string; responses: DavResponse[] }> {
    const res = await this.request(method, url, body, depth);
    try {
      return { url: res.url, responses: multistatus(res.xml) };
    } catch {
      throw new CalendarError("iCloud Calendar sent a reply Atlas couldn't read.", "protocol");
    }
  }
}

/** The href inside `prop` (such as current-user-principal), resolved against `base`. */
function hrefIn(responses: DavResponse[], prop: string, base: string): string {
  for (const r of responses) {
    const node = find(r.props, prop);
    const href = node ? textOf(node, "href") : undefined;
    if (href) return new URL(href, base).toString();
  }
  throw new CalendarError(
    `iCloud Calendar didn't say where your ${prop === "calendar-home-set" ? "calendars are" : "account is"}.`,
    "protocol",
  );
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function isEventCalendar(props: XmlNode): boolean {
  const type = find(props, "resourcetype");
  if (!type || !type.children.some((c) => c.name === "calendar")) return false;
  const set = find(props, "supported-calendar-component-set");
  if (!set) return true; // not declared: assume it holds events
  return findAll(set, "comp").some((c) => (c.attrs.name ?? "").toUpperCase() === "VEVENT");
}

function lastSegment(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "Calendar");
}

/** Sort key in ms. An all-day date sorts at its UTC midnight. */
function startKey(ev: CalendarEvent): number {
  return ev.all_day ? Date.parse(`${ev.start}T00:00:00Z`) : Date.parse(ev.start);
}

function overlaps(ev: CalendarEvent, range: CalendarRange): boolean {
  if (ev.all_day) {
    // Dates are local to the owner; allow a day either side, since the server already filtered.
    const s = Date.parse(`${ev.start}T00:00:00Z`);
    const e = Date.parse(`${ev.end}T00:00:00Z`);
    return s < range.end.getTime() + DAY_MS && e > range.start.getTime() - DAY_MS;
  }
  const s = Date.parse(ev.start);
  const e = Date.parse(ev.end);
  if (e === s) return s >= range.start.getTime() && s < range.end.getTime();
  return s < range.end.getTime() && e > range.start.getTime();
}

export function icloudCalendar(creds: ICloudCredentials, opts: CalDavOptions = {}): CalendarSource {
  const client = new CalDavClient(creds, opts.fetch ?? fetch);
  const base = opts.baseUrl ?? ICLOUD_CALDAV;
  const hidden = new Set((opts.hidden ?? []).map((n) => n.trim().toLowerCase()));
  let cached: Promise<DavCalendar[]> | null = null;

  async function discover(): Promise<DavCalendar[]> {
    const principal = await client.multistatus("PROPFIND", base, PROPFIND_PRINCIPAL, "0");
    const principalUrl = hrefIn(principal.responses, "current-user-principal", principal.url);
    const home = await client.multistatus("PROPFIND", principalUrl, PROPFIND_HOME, "0");
    const homeUrl = hrefIn(home.responses, "calendar-home-set", home.url);
    const listing = await client.multistatus("PROPFIND", homeUrl, PROPFIND_CALENDARS, "1");
    const out: DavCalendar[] = [];
    for (const r of listing.responses) {
      if (!r.href) continue;
      const url = new URL(r.href, listing.url).toString();
      if (sameUrl(url, homeUrl) || !isEventCalendar(r.props)) continue;
      const name = textOf(r.props, "displayname") || lastSegment(url);
      if (hidden.has(name.trim().toLowerCase())) continue;
      out.push({ url, name });
    }
    return out;
  }

  function calendars(): Promise<DavCalendar[]> {
    if (!cached) {
      const p = discover();
      cached = p;
      p.catch(() => {
        if (cached === p) cached = null; // try discovery again next time
      });
    }
    return cached;
  }

  async function eventsIn(cal: DavCalendar, range: CalendarRange): Promise<CalendarEvent[]> {
    const res = await client.multistatus("REPORT", cal.url, calendarQuery(range), "1");
    const events: CalendarEvent[] = [];
    for (const r of res.responses) {
      const data = textOf(r.props, "calendar-data");
      if (data) events.push(...parseEvents(data, cal.name, opts.timezone));
    }
    return events;
  }

  async function list(range: CalendarRange): Promise<CalendarEvent[]> {
    const cals = await calendars();
    const perCal = await Promise.all(cals.map((c) => eventsIn(c, range)));
    // The same instance can come back twice (an event shared onto two calendars); keep the first.
    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    for (const ev of perCal.flat()) {
      if (!overlaps(ev, range)) continue;
      const key = `${ev.id}|${ev.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
    return out.sort((a, b) => startKey(a) - startKey(b) || a.title.localeCompare(b.title));
  }

  async function check(): Promise<CalendarCheck> {
    cached = null; // a live check always signs in again
    const cals = await calendars();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const events = await list({ start, end: new Date(start.getTime() + 30 * DAY_MS) });
    return { calendars: cals.map((c) => c.name), events_next_30_days: events.length };
  }

  return { list, check };
}
