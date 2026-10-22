import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CalendarCopy, calendarQuery, cleanCredentials, copySpan, davTime, FRESH_MS, icloudCalendar } from "../src/calendar/caldav";
import { parseDuration, parseEvents, resolveZone, unfold, zonedToUtc } from "../src/calendar/ical";
import { CalendarError } from "../src/calendar/types";
import { multistatus, parseXml, find } from "../src/calendar/xml";
import principalXml from "./fixtures/caldav/principal.xml?raw";
import homeXml from "./fixtures/caldav/home.xml?raw";
import calendarsXml from "./fixtures/caldav/calendars.xml?raw";
import homeEventsXml from "./fixtures/caldav/home-events.xml?raw";
import workEventsXml from "./fixtures/caldav/work-events.xml?raw";

const CREDS = { username: "owner@icloud.com", app_password: "abcd-efgh-ijkl-mnop" };
const EMPTY = `<?xml version="1.0"?><multistatus xmlns="DAV:"></multistatus>`;

interface Seen {
  method: string;
  url: string;
  depth: string | null;
  auth: string | null;
  agent: string | null;
  body: string;
}

/** The CalendarError a failing call threw. */
async function failure(p: Promise<unknown>): Promise<CalendarError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof CalendarError)) throw new Error(`expected a CalendarError, got ${String(e)}`);
  return e;
}

/** A fake iCloud: discovery on caldav.icloud.com, a redirect to the p42 host, then the home. */
function fakeICloud(listing: () => string = () => calendarsXml) {
  const seen: Seen[] = [];
  const xml = (body: string, status = 207) => new Response(body, { status, headers: { "Content-Type": "text/xml" } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    const method = init?.method ?? "GET";
    seen.push({ method, url, depth: headers.get("Depth"), auth: headers.get("Authorization"), agent: headers.get("User-Agent"), body });
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/") return xml(principalXml);
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/123456789/principal/") {
      return new Response(null, { status: 302, headers: { Location: "https://p42-caldav.icloud.com/123456789/principal/" } });
    }
    if (method === "PROPFIND" && url === "https://p42-caldav.icloud.com/123456789/principal/") return xml(homeXml);
    if (method === "PROPFIND" && url === "https://p42-caldav.icloud.com/123456789/calendars/") return xml(listing());
    if (method === "REPORT" && url.endsWith("/calendars/home/")) return xml(homeEventsXml);
    if (method === "REPORT" && url.endsWith("/calendars/work%20cal/")) return xml(workEventsXml);
    if (method === "REPORT" && url.endsWith("/calendars/birthdays/")) return xml(EMPTY);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const WEEK = { start: new Date("2026-10-19T00:00:00Z"), end: new Date("2026-10-27T00:00:00Z") };

describe("ical", () => {
  it("unfolds lines and unescapes text, ignoring a nested VALARM", () => {
    const xml = multistatus(homeEventsXml);
    const dentist = xml.find((r) => r.href.endsWith("dentist.ics"))!;
    const ics = find(dentist.props, "calendar-data")!.text;
    const [ev] = parseEvents(ics, "Home");
    expect(ev).toMatchObject({
      id: "dentist-2",
      title: "Dentist",
      notes: "Bring the insurance card\nand the form; ask about the crown",
      start: "2026-10-22T15:00:00.000Z",
      end: "2026-10-22T16:00:00.000Z",
      all_day: false,
    });
    expect(unfold("A:one\r\n two\r\n\tthree")).toEqual(["A:onetwothree"]);
  });

  it("keeps each expanded instance of a recurring event apart", () => {
    const ics = find(multistatus(homeEventsXml)[0]!.props, "calendar-data")!.text;
    const evs = parseEvents(ics, "Home");
    expect(evs.map((e) => e.id)).toEqual(["standup-1@icloud.com::20261019T140000Z", "standup-1@icloud.com::20261026T140000Z"]);
    expect(evs[1]!.start).toBe("2026-10-26T14:00:00.000Z");
  });

  it("reads all-day events as plain dates with an exclusive end", () => {
    const [ev] = parseEvents(
      "BEGIN:VEVENT\nUID:t\nDTSTART;VALUE=DATE:20261023\nDTEND;VALUE=DATE:20261025\nSUMMARY:Trip\nLOCATION:Austin\\, TX\nEND:VEVENT",
      "Home",
    );
    expect(ev).toMatchObject({ start: "2026-10-23", end: "2026-10-25", all_day: true, location: "Austin, TX" });
    const [noEnd] = parseEvents("BEGIN:VEVENT\nUID:t\nDTSTART;VALUE=DATE:20261031\nEND:VEVENT", "Home");
    expect(noEnd).toMatchObject({ start: "2026-10-31", end: "2026-11-01", title: "(no title)" });
  });

  it("drops cancelled events", () => {
    expect(parseEvents("BEGIN:VEVENT\nUID:x\nDTSTART:20261021T180000Z\nSTATUS:CANCELLED\nEND:VEVENT", "Home")).toEqual([]);
  });

  it("converts TZID times to UTC across daylight saving", () => {
    const summer = parseEvents(
      "BEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/New_York:20261022T090000\nDTEND;TZID=America/New_York:20261022T100000\nEND:VEVENT",
      "W",
    );
    expect(summer[0]).toMatchObject({ start: "2026-10-22T13:00:00.000Z", end: "2026-10-22T14:00:00.000Z" });
    const winter = parseEvents(
      'BEGIN:VEVENT\nUID:b\nDTSTART;TZID="/mozilla.org/20050126_1/America/New_York":20261201T090000\nEND:VEVENT',
      "W",
    );
    expect(winter[0]!.start).toBe("2026-12-01T14:00:00.000Z");
    expect(resolveZone("Not/AZone")).toBeNull();
    expect(new Date(zonedToUtc(Date.UTC(2026, 6, 1, 12), "Europe/London")).toISOString()).toBe("2026-07-01T11:00:00.000Z");
  });

  it("uses DURATION when there is no DTEND, and a point in time when there is neither", () => {
    const [call] = parseEvents("BEGIN:VEVENT\nUID:c\nDTSTART:20261022T200000Z\nDURATION:PT45M\nEND:VEVENT", "W");
    expect(call!.end).toBe("2026-10-22T20:45:00.000Z");
    const [point] = parseEvents("BEGIN:VEVENT\nUID:p\nDTSTART:20261022T200000Z\nEND:VEVENT", "W");
    expect(point!.end).toBe(point!.start);
    expect(parseDuration("P1W")).toBe(7 * 86_400_000);
    expect(parseDuration("PT1H30M")).toBe(5_400_000);
    expect(parseDuration("P")).toBeNull();
  });

  it("reads floating times in the owner's zone when given one", () => {
    const ics = "BEGIN:VEVENT\nUID:g\nDTSTART:20261021T070000\nEND:VEVENT";
    expect(parseEvents(ics, "W")[0]!.start).toBe("2026-10-21T07:00:00.000Z");
    expect(parseEvents(ics, "W", "America/Los_Angeles")[0]!.start).toBe("2026-10-21T14:00:00.000Z");
  });
});

describe("xml", () => {
  it("keeps only successful props, decodes entities and reads CDATA", () => {
    const rs = multistatus(calendarsXml);
    expect(rs[0]!.props.children.map((c) => c.name)).toEqual(["resourcetype"]);
    expect(find(rs[2]!.props, "displayname")!.text).toBe("Work & Studio");
    const work = multistatus(workEventsXml);
    expect(find(work[3]!.props, "calendar-data")!.text).toContain("UID:dentist-2");
    expect(() => parseXml("<a><b></a>")).toThrow();
  });
});

describe("icloudCalendar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-21T09:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds event calendars through the principal and the pNN home host", async () => {
    const { fetchFn, seen } = fakeICloud();
    const cal = icloudCalendar(CREDS, { fetch: fetchFn, hidden: [" birthdays "] });
    const result = await cal.check();
    expect(result.calendars).toEqual(["Home", "Work & Studio"]);
    const propfinds = seen.filter((s) => s.method === "PROPFIND");
    expect(propfinds.map((s) => s.url)).toEqual([
      "https://caldav.icloud.com/",
      "https://caldav.icloud.com/123456789/principal/",
      "https://p42-caldav.icloud.com/123456789/principal/",
      // The home href carries ":443"; URL resolution drops the default port.
      "https://p42-caldav.icloud.com/123456789/calendars/",
    ]);
    expect(propfinds.map((s) => s.depth)).toEqual(["0", "0", "0", "1"]);
    expect(seen.every((s) => s.auth === `Basic ${btoa("owner@icloud.com:abcd-efgh-ijkl-mnop")}`)).toBe(true);
    expect(seen.every((s) => s.agent?.startsWith("Atlas/"))).toBe(true);
    // Next 30 days from Oct 21: standup Oct 26, trip, dentist (once), review, call, gym. Not the Oct 19 standup.
    expect(result.events_next_30_days).toBe(6);
  });

  it("lists events in range, sorted, deduplicated, with recurrences expanded by the server", async () => {
    const { fetchFn, seen } = fakeICloud();
    const cal = icloudCalendar(CREDS, { fetch: fetchFn });
    const range = { start: new Date("2026-10-21T12:00:00Z"), end: new Date("2026-10-27T00:00:00Z") };
    const events = await cal.list(range);
    expect(events.map((e) => `${e.calendar}: ${e.title}`)).toEqual([
      "Work & Studio: Design review",
      "Home: Dentist",
      "Work & Studio: Client call",
      "Home: Trip to Austin",
      "Home: Standup",
    ]);
    // Each calendar is read once, for the copy's whole span, recurrences expanded by iCloud.
    const { from, to } = copySpan(Date.now());
    const span = `start="${davTime(new Date(from))}" end="${davTime(new Date(to))}"`;
    const report = seen.find((s) => s.method === "REPORT")!;
    expect(report.depth).toBe("1");
    expect(report.body).toContain(`<c:expand ${span}/>`);
    expect(report.body).toContain(`<c:time-range ${span}/>`);
    expect(seen.filter((s) => s.method === "REPORT")).toHaveLength(3);

    // Another question right away is answered from the copy, without asking iCloud.
    const before = seen.length;
    expect((await cal.list(WEEK)).length).toBeGreaterThan(0);
    expect(seen.length).toBe(before);
  });

  it("explains a rejected sign-in in owner words", async () => {
    const fetchFn = (async () => new Response("", { status: 401 })) as typeof fetch;
    const err = await failure(icloudCalendar(CREDS, { fetch: fetchFn }).list(WEEK));
    expect(err.code).toBe("auth");
    expect(err.message).toMatch(/app-specific password/);
  });

  it("reports network failures and timeouts as network errors", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const slow = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    const a = await failure(icloudCalendar(CREDS, { fetch: down }).list(WEEK));
    const b = await failure(icloudCalendar(CREDS, { fetch: slow }).list(WEEK));
    expect([a.code, b.code]).toEqual(["network", "network"]);
    expect(b.message).toMatch(/in time/);
  });

  it("reports a reply it can't read as a protocol error, and retries discovery after a failure", async () => {
    let broken = true;
    const { fetchFn } = fakeICloud();
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) =>
      broken ? new Response("<html>oops", { status: 207 }) : fetchFn(input, init)) as typeof fetch;
    const cal = icloudCalendar(CREDS, { fetch: flaky });
    const err = await failure(cal.list(WEEK));
    expect(err.code).toBe("protocol");
    broken = false;
    expect((await cal.list(WEEK)).length).toBeGreaterThan(0);
  });

  it("formats CalDAV times", () => {
    expect(davTime(new Date("2026-10-22T14:05:09.123Z"))).toBe("20261022T140509Z");
    expect(calendarQuery(WEEK)).toContain('name="VEVENT"');
  });

  it("calls fetch as a plain function, as the Workers runtime requires", async () => {
    // Like Workers' own fetch: called as a method of another object, it throws.
    const strict = function (this: unknown) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      return Promise.resolve(new Response("", { status: 401 }));
    } as unknown as typeof fetch;
    const cal = icloudCalendar({ username: "max@icloud.com", app_password: "abcd-efgh-ijkl-mnop" }, { fetch: strict });
    await expect(cal.check()).rejects.toMatchObject({ code: "auth" });
  });

  it("sends the app-specific password in Apple's form however it was pasted", async () => {
    for (const pasted of ["abcd efgh-ijkl-mnop ", "abcdefghijklmnop", "ABCD-EFGH-IJKL-MNOP", "abcd efgh ijkl mnop"]) {
      expect(cleanCredentials({ username: " owner@icloud.com\n", app_password: pasted })).toEqual({
        username: "owner@icloud.com",
        app_password: "abcd-efgh-ijkl-mnop",
      });
    }
    // Anything that isn't one is only trimmed, so the owner's own words reach iCloud.
    expect(cleanCredentials({ username: "a@b.c", app_password: " My Password1 " }).app_password).toBe("MyPassword1");
    const { fetchFn, seen } = fakeICloud();
    await icloudCalendar({ username: " owner@icloud.com ", app_password: " abcd-efgh-ijkl-mnop\n" }, { fetch: fetchFn }).check();
    expect(seen[0]!.auth).toBe(`Basic ${btoa("owner@icloud.com:abcd-efgh-ijkl-mnop")}`);
  });

  it("says which iCloud server refused, and doesn't call a 403 a wrong password", async () => {
    const { fetchFn } = fakeICloud();
    const laterHost = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://p42-caldav.icloud.com/")
        ? new Response("", { status: 401 })
        : fetchFn(input, init)) as typeof fetch;
    const a = await icloudCalendar(CREDS, { fetch: laterHost })
      .check()
      .catch((e: unknown) => e as CalendarError);
    expect(a).toMatchObject({ code: "auth" });
    expect((a as CalendarError).message).toContain("at p42-caldav.icloud.com, after caldav.icloud.com accepted the sign-in");

    const forbidden = (async () => new Response("<html><body>Forbidden for this account</body></html>", { status: 403 })) as typeof fetch;
    const b = await icloudCalendar(CREDS, { fetch: forbidden })
      .check()
      .catch((e: unknown) => e as CalendarError);
    expect(b).toMatchObject({ code: "protocol" });
    expect((b as CalendarError).message).toBe("iCloud refused the request at caldav.icloud.com (HTTP 403: Forbidden for this account).");
  });

  it("keeps a copy between wakes, and after that checks every calendar with one request, reading only what changed", async () => {
    let homeTag = "HwoQEgwAAA-home-1";
    const { fetchFn, seen } = fakeICloud(() => calendarsXml.replace("HwoQEgwAAA-home-1", homeTag));
    let inFlight = 0;
    let most = 0;
    const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await fetchFn(input, init);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;
    let stored: CalendarCopy | null = null;
    const store = { load: () => stored, save: (c: CalendarCopy | null) => (stored = c) };

    // Two questions at once share one sync, and calendars are read two at a time.
    const first = icloudCalendar(CREDS, { fetch: counted, store });
    await Promise.all([first.list(WEEK), first.list(WEEK)]);
    expect(seen.filter((r) => r.method === "REPORT")).toHaveLength(3);
    expect(most).toBeLessThanOrEqual(2);
    expect(stored!.calendars.map((c) => c.tag)).toEqual([
      "HwoQEgwAAA-home-1",
      "HwoQEgwAAA-work-1",
      "https://caldav.icloud.com/sync/birthdays-1",
    ]);

    // The agent woke up: a fresh copy answers without asking iCloud at all.
    seen.length = 0;
    const woke = icloudCalendar(CREDS, { fetch: counted, store });
    const events = await woke.list(WEEK);
    expect(seen).toEqual([]);
    expect(woke.held!(WEEK)).toEqual({ events, as_of: stored!.synced_at });

    // Later, one request lists every calendar's tag; nothing changed, so nothing is read again.
    vi.setSystemTime(Date.now() + FRESH_MS + 1);
    await woke.list(WEEK);
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["PROPFIND https://p42-caldav.icloud.com/123456789/calendars/"]);

    // An event changed on Home: only Home is read again.
    seen.length = 0;
    homeTag = "HwoQEgwAAA-home-2";
    vi.setSystemTime(Date.now() + FRESH_MS + 1);
    await woke.list(WEEK);
    expect(seen.map((r) => r.method)).toEqual(["PROPFIND", "REPORT"]);
    expect(seen[1]!.url).toContain("/calendars/home/");
  });

  it("reads a range outside the copy straight from iCloud", async () => {
    const { fetchFn, seen } = fakeICloud();
    const cal = icloudCalendar(CREDS, { fetch: fetchFn });
    await cal.list(WEEK);
    seen.length = 0;
    const later = { start: new Date("2027-06-01T00:00:00Z"), end: new Date("2027-06-08T00:00:00Z") };
    await cal.list(later);
    expect(seen.map((r) => r.method)).toEqual(["REPORT", "REPORT", "REPORT"]);
    expect(seen[0]!.body).toContain('<c:expand start="20270601T000000Z" end="20270608T000000Z"/>');
    expect(cal.held!(later)).toBeNull();
  });
});
