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
  /** Where the copy of the calendar is kept between wakes. */
  store?: { load(): CalendarCopy | null; save(copy: CalendarCopy | null): void };
}

/** At most this many calendars are read at once, so a sync isn't a burst of sign-ins. */
export const MAX_PARALLEL_READS = 2;
/** A copy checked with iCloud this recently answers without asking again. */
export const FRESH_MS = 60_000;
/** The copy covers a week back through ten weeks ahead, moving once a week. */
const WEEK_MS = 7 * 86_400_000;

/**
 * Atlas's copy of the owner's calendars (§10.1: a sense, kept, not fetched
 * per question). Every request to iCloud carries the Apple ID and password,
 * so each one counts as a sign-in; with a copy, a question costs at most one
 * request (each calendar's change tag, in one listing), and only calendars
 * that changed are read again.
 */
export interface CalendarCopy {
  /** The calendar home, found once through the principal. */
  home: string;
  /** The span the copy holds, in ms since the epoch. */
  from: number;
  to: number;
  /** The zone floating times were read in. */
  tz: string;
  /** When iCloud last answered a sync. */
  synced_at: number;
  calendars: CopiedCalendar[];
}

export interface CopiedCalendar extends DavCalendar {
  /** iCloud's change tag for the calendar: unchanged means its events are too. */
  tag: string | null;
  events: CalendarEvent[];
}

export interface DavCalendar {
  url: string;
  name: string;
}

/** The span a copy made at `now` holds: from the start of last week through ten weeks on. */
export function copySpan(now: number): { from: number; to: number } {
  const week = Math.floor(now / WEEK_MS) * WEEK_MS;
  return { from: week - WEEK_MS, to: week + 10 * WEEK_MS };
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/></d:prop>
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

/**
 * The credentials as iCloud expects them. An app-specific password is 16
 * letters that Apple shows as xxxx-xxxx-xxxx-xxxx; however it was pasted or
 * typed (spaces, no dashes, capitals), it's sent in that form.
 */
export function cleanCredentials(creds: ICloudCredentials): ICloudCredentials {
  const letters = creds.app_password.replace(/[\s-]+/g, "");
  const app_password = /^[a-z]{16}$/i.test(letters)
    ? (letters.toLowerCase().match(/.{4}/g) ?? []).join("-")
    : creds.app_password.replace(/\s+/g, "");
  return { username: creds.username.trim(), app_password };
}

/** Atlas says who it is, as well-behaved CalDAV clients do. */
const USER_AGENT = "Atlas/1.0 (CalDAV; +https://github.com/maxjb-xyz/atlas)";

function basicAuth(creds: ICloudCredentials): string {
  const c = cleanCredentials(creds);
  const bytes = new TextEncoder().encode(`${c.username}:${c.app_password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

const AUTH_REASON = "iCloud didn't accept the Apple ID and app-specific password";

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
            "User-Agent": USER_AGENT,
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
        // Apple's own markers, so a refusal can be told apart later: whether it asked for a password again
        // (a missing challenge points at Apple limiting sign-ins rather than a wrong password), its request id and partition.
        console.error(
          JSON.stringify({
            event: "caldav.refused",
            method,
            host,
            status: res.status,
            challenge: res.headers.get("WWW-Authenticate") ?? "none",
            apple_request: res.headers.get("X-Apple-Request-UUID"),
            partition: res.headers.get("X-Apple-User-Partition"),
            said,
          }),
        );
        if (res.status === 401) {
          // Which server refused matters: a refusal after the first hop means the password was accepted there.
          const first = new URL(this.#start).host;
          const where = host === first ? ` at ${host}` : ` at ${host}, after ${first} accepted the sign-in`;
          throw new CalendarError(`${AUTH_REASON} (HTTP 401${where}).`, "auth");
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
  const tz = opts.timezone ?? "UTC";
  let copy = usable(opts.store?.load() ?? null);
  let syncing: Promise<CalendarCopy> | null = null;

  /** A stored copy from an older version, or in another zone, is only kept for its calendar home. */
  function usable(c: CalendarCopy | null): CalendarCopy | null {
    if (!c || typeof c.home !== "string" || !Array.isArray(c.calendars)) return null;
    return c.tz === tz ? c : { ...c, synced_at: 0, calendars: c.calendars.map((cal) => ({ ...cal, tag: null })) };
  }

  async function findHome(): Promise<string> {
    const principal = await client.multistatus("PROPFIND", base, PROPFIND_PRINCIPAL, "0");
    const principalUrl = hrefIn(principal.responses, "current-user-principal", principal.url);
    const home = await client.multistatus("PROPFIND", principalUrl, PROPFIND_HOME, "0");
    return hrefIn(home.responses, "calendar-home-set", home.url);
  }

  /** Every event calendar in the home, with its change tag: one request. */
  async function listCalendars(home: string): Promise<Array<DavCalendar & { tag: string | null }>> {
    const listing = await client.multistatus("PROPFIND", home, PROPFIND_CALENDARS, "1");
    const out: Array<DavCalendar & { tag: string | null }> = [];
    for (const r of listing.responses) {
      if (!r.href) continue;
      const url = new URL(r.href, listing.url).toString();
      if (sameUrl(url, home) || !isEventCalendar(r.props)) continue;
      const name = textOf(r.props, "displayname") || lastSegment(url);
      out.push({ url, name, tag: textOf(r.props, "getctag") || textOf(r.props, "sync-token") || null });
    }
    return out;
  }

  /**
   * Brings the copy up to date: the calendar list with change tags, then
   * only the calendars whose tag moved (or every one, once a week, when the
   * span moves). `rediscover` finds the calendar home again first.
   */
  async function sync(rediscover = false): Promise<CalendarCopy> {
    let home = !rediscover && copy?.home ? copy.home : await findHome();
    let cals: Array<DavCalendar & { tag: string | null }>;
    try {
      cals = await listCalendars(home);
    } catch (err) {
      // A remembered home that moved: find it again, once.
      if (!(err instanceof CalendarError) || err.code !== "protocol" || home !== copy?.home) throw err;
      home = await findHome();
      cals = await listCalendars(home);
    }
    const { from, to } = copySpan(Date.now());
    const same = copy && copy.from === from && copy.to === to ? copy : null;
    const before = new Map((same?.calendars ?? []).map((c) => [c.url, c]));
    const calendars = await inBatches(cals, MAX_PARALLEL_READS, async (c): Promise<CopiedCalendar> => {
      const had = before.get(c.url);
      if (had && c.tag && had.tag === c.tag) return { ...had, name: c.name };
      return { ...c, events: await eventsIn(c, { start: new Date(from), end: new Date(to) }) };
    });
    const next: CalendarCopy = { home, from, to, tz, synced_at: Date.now(), calendars };
    copy = next;
    opts.store?.save(next);
    return next;
  }

  /** One sync at a time: questions that arrive together share it. */
  function syncOnce(rediscover = false): Promise<CalendarCopy> {
    if (!syncing) {
      syncing = sync(rediscover).finally(() => {
        syncing = null;
      });
    }
    return syncing;
  }

  async function eventsIn(cal: DavCalendar, range: CalendarRange): Promise<CalendarEvent[]> {
    const res = await client.multistatus("REPORT", cal.url, calendarQuery(range), "1");
    const events: CalendarEvent[] = [];
    for (const r of res.responses) {
      const data = textOf(r.props, "calendar-data");
      if (data) events.push(...parseEvents(data, cal.name, tz));
    }
    return events;
  }

  const covers = (c: CalendarCopy | null, range: CalendarRange) =>
    c != null && range.start.getTime() >= c.from && range.end.getTime() <= c.to;
  const visible = (name: string) => !hidden.has(name.trim().toLowerCase());

  function pick(perCal: Array<{ name: string; events: CalendarEvent[] }>, range: CalendarRange): CalendarEvent[] {
    // The same instance can come back twice (an event shared onto two calendars); keep the first.
    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    for (const cal of perCal) {
      if (!visible(cal.name)) continue;
      for (const ev of cal.events) {
        if (!overlaps(ev, range)) continue;
        const key = `${ev.id}|${ev.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ev);
      }
    }
    return out.sort((a, b) => startKey(a) - startKey(b) || a.title.localeCompare(b.title));
  }

  async function list(range: CalendarRange): Promise<CalendarEvent[]> {
    let c = copy;
    if (!c || Date.now() - c.synced_at > FRESH_MS) c = await syncOnce();
    if (covers(c, range)) return pick(c.calendars, range);
    // Far from today: read just this range, from the calendars the copy knows.
    const cals = c.calendars.filter((cal) => visible(cal.name));
    const perCal = await inBatches(cals, MAX_PARALLEL_READS, async (cal) => ({ name: cal.name, events: await eventsIn(cal, range) }));
    return pick(perCal, range);
  }

  function held(range: CalendarRange): { events: CalendarEvent[]; as_of: number } | null {
    if (!copy || !copy.synced_at || !covers(copy, range)) return null;
    return { events: pick(copy.calendars, range), as_of: copy.synced_at };
  }

  async function check(): Promise<CalendarCheck> {
    // A live check always signs in from the start, finding the calendar home again.
    const c = await syncOnce(true);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const events = pick(c.calendars, { start, end: new Date(start.getTime() + 30 * DAY_MS) });
    return { calendars: c.calendars.filter((cal) => visible(cal.name)).map((cal) => cal.name), events_next_30_days: events.length };
  }

  return { list, held, check };
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
