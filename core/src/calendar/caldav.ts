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
  /**
   * Somewhere to keep the calendar list between wakes, so a sleeping agent
   * doesn't sign in three extra times to find the calendars again.
   */
  remember?: { load(): RememberedCalendars | null; save(calendars: RememberedCalendars | null): void };
}

/** At most this many calendars are read at once, so a question isn't a burst of sign-ins. */
export const MAX_PARALLEL_READS = 2;
/** The same range asked again this soon (the brain asking twice in one reply) is answered from the last read. */
export const REUSE_MS = 15_000;
/** The remembered calendar list is found afresh after this long, so new calendars show up. */
export const REDISCOVER_MS = 6 * 3_600_000;

export interface RememberedCalendars {
  at: number;
  calendars: DavCalendar[];
}

export interface DavCalendar {
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

/** The credentials as iCloud expects them: no stray spaces from copying and pasting. */
export function cleanCredentials(creds: ICloudCredentials): ICloudCredentials {
  return { username: creds.username.trim(), app_password: creds.app_password.replace(/\s+/g, "") };
}

function basicAuth(creds: ICloudCredentials): string {
  const c = cleanCredentials(creds);
  const bytes = new TextEncoder().encode(`${c.username}:${c.app_password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

const AUTH_REASON =
  "iCloud didn't accept the Apple ID and app-specific password. Make a new app-specific password at account.apple.com (Sign-In and Security) and paste it in Settings. Your normal Apple ID password won't work here.";

class CalDavClient {
  #fetch: typeof fetch;
  #auth: string;
  /** Where discovery starts, so a refusal can say whether it came at the first server or a later one. */
  #start: string;

  constructor(creds: ICloudCredentials, fetchFn: typeof fetch, start: string) {
    this.#start = start;
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
      if (res.status === 401 || res.status === 403) {
        const host = new URL(target).host;
        const said = (await res.text().catch(() => ""))
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
        console.error(JSON.stringify({ event: "caldav.refused", method, host, status: res.status, said }));
        if (res.status === 401) {
          // Which server refused matters: a refusal after the first hop means the password was accepted there.
          const first = new URL(this.#start).host;
          const where = host === first ? ` at ${host}` : ` at ${host}, after ${first} accepted the sign-in`;
          throw new CalendarError(`${AUTH_REASON} iCloud answered HTTP 401${where}.`, "auth");
        }
        throw new CalendarError(`iCloud refused the request at ${host} (HTTP 403${said ? `: ${said}` : ""}).`, "protocol");
      }
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
  const base = opts.baseUrl ?? ICLOUD_CALDAV;
  const client = new CalDavClient(creds, opts.fetch ?? fetch, base);
  const hidden = new Set((opts.hidden ?? []).map((n) => n.trim().toLowerCase()));
  const remembered = opts.remember?.load();
  const fresh = remembered && Array.isArray(remembered.calendars) && Date.now() - remembered.at < REDISCOVER_MS;
  let cached: Promise<DavCalendar[]> | null = fresh && remembered.calendars.length ? Promise.resolve(remembered.calendars) : null;
  let foundAt = fresh ? remembered.at : 0;
  const recent = new Map<string, { at: number; events: CalendarEvent[] }>();

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
    if (cached && foundAt && Date.now() - foundAt > REDISCOVER_MS) cached = null;
    if (!cached) {
      const p = discover();
      cached = p;
      p.then(
        (cals) => {
          foundAt = Date.now();
          opts.remember?.save({ at: foundAt, calendars: cals });
        },
        () => {
          if (cached === p) cached = null; // try discovery again next time
        },
      );
    }
    return cached;
  }

  /** A calendar moved or vanished: forget the list so the next read finds them again. */
  function forget(): void {
    cached = null;
    opts.remember?.save(null);
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
    const key = `${range.start.getTime()}|${range.end.getTime()}`;
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < REUSE_MS) return hit.events;
    const cals = await calendars();
    let perCal: CalendarEvent[][];
    try {
      perCal = await inBatches(cals, MAX_PARALLEL_READS, (c) => eventsIn(c, range));
    } catch (err) {
      if (err instanceof CalendarError && err.code === "protocol") forget();
      throw err;
    }
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
    const sorted = out.sort((a, b) => startKey(a) - startKey(b) || a.title.localeCompare(b.title));
    recent.set(key, { at: Date.now(), events: sorted });
    return sorted;
  }

  async function check(): Promise<CalendarCheck> {
    forget(); // a live check always signs in again
    recent.clear();
    const cals = await calendars();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const events = await list({ start, end: new Date(start.getTime() + 30 * DAY_MS) });
    return { calendars: cals.map((c) => c.name), events_next_30_days: events.length };
  }

  return { list, check };
}

/** Runs `fn` over `items`, at most `n` at a time, keeping the order of results. */
async function inBatches<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
