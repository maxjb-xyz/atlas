// The contract between Atlas's core and its extensions (VISION §17).
//
// An extension is one module whose default export is an `Extension`: a
// manifest that says what it provides and what it may touch, and the calls
// the core makes on it. It runs sandboxed in a Dynamic Worker, and its only
// way out is the core's gate, which lets it reach the hosts its manifest
// names and nothing else. It never sees a secret's value: `ctx.secret(name)`
// gives a placeholder, and the gate puts the value in as the request leaves.
// It never sees the log, the records or the owner's other connections: each
// call gets what it needs in `ctx` and its arguments, and gives back typed
// results. What it notices goes into the intake, and what it sends leaves
// through the core's outbox, with the owner's OK where that's needed.
//
// Throw a `Failure` with the service's own words (its HTTP status, host and
// message) when something goes wrong: the owner sees it on the Senses screen.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

/** What an extension can provide. A call the core makes needs its kind here and its method below. */
export type Provides =
  /** Items for the intake (§10.4): `look` on the clock, or `receive` for posts. */
  | "sense"
  /** A chat channel (§16.1): messages in through `receive`, out through `send`. */
  | "channel"
  /** The owner's own mail: items through `look`, and `mail` to send as the owner. */
  | "mail"
  /** Sending mail from Atlas's own address: `mail`. */
  | "sending"
  /** The owner's calendar: `calendar`. */
  | "calendar"
  /** The owner's address book: `contacts`. */
  | "contacts"
  /** Where the owner is, from an app on their phone: fixes through `receive`. */
  | "location"
  /** Addresses, routes and places: `geocode`, `reverse`, `route`, `nearby`. */
  | "maps"
  /** The weather for a rough area: `weather`. */
  | "weather"
  /** Web search: `search`. */
  | "search";

export interface SecretSpec {
  name: string;
  /** What to paste, in a few words: "A personal access token". */
  label: string;
  /** Where to get it, in a sentence or two. */
  help?: string;
  optional?: boolean;
}

export interface SettingSpec {
  name: string;
  label: string;
  help?: string;
  default?: string;
  optional?: boolean;
}

/**
 * A sign-in the core runs for the extension (OAuth 2.0 with a code). The
 * owner's own client is a setting named `client_id` and a secret named
 * `client_secret`; the tokens it gets are secrets named `access_token` and
 * `refresh_token`, which the core keeps fresh.
 */
export interface SignIn {
  authorize: string;
  token: string;
  scopes: string[];
  /** More parameters for the sign-in page: Google wants access_type=offline and prompt=consent. */
  params?: Record<string, string>;
  /** How to make the client, in a few sentences, with the redirect address the core shows beside it. */
  help: string;
}

/** A signature the core checks on each post before the extension sees it: HMAC-SHA256 of the body with a secret, in hex. */
export interface Signature {
  header: string;
  /** What comes before the hex: "sha256=". */
  prefix?: string;
  /** The secret's name. */
  secret: string;
}

export interface Manifest {
  /** Lowercase, stable: "github", "icloud". */
  id: string;
  name: string;
  version: string;
  /** What it does, in a sentence the owner reads before installing it. */
  about: string;
  provides: Provides[];
  /** The only hosts it may reach. "example.com" also covers its subdomains. */
  hosts: string[];
  secrets?: SecretSpec[];
  settings?: SettingSpec[];
  signin?: SignIn;
  /** Minutes between looks on the clock, for a source that can't post to Atlas. */
  every?: number;
  /** Secrets a look needs: until they're set, it isn't put on the clock (an extension used only for webhooks). */
  look_needs?: string[];
  /**
   * It takes posts at an address of its own; with a signature, the core checks it first. `claims` are headers
   * that mark a post as its service's when it arrives at one of the owner's general webhook sources (§10.4):
   * the core checks that source's key, then hands the post to this extension to read.
   */
  receives?: { signature?: Signature; claims?: string[] };
  /** The least time between two calls, for free services that ask to be called gently. */
  pace_ms?: number;
  /** What it costs while it's on, when that isn't nothing. */
  costs?: string;
  /** The credit its data needs wherever it's shown: "© OpenStreetMap contributors". */
  credit?: string;
}

/** What every call gets. */
export interface Ctx {
  /** Where the last look left off (Gmail's history id, a time), or null the first time. */
  cursor: Json;
  /** What the extension keeps between calls, such as a copy of a calendar. */
  state: Json;
  settings: Record<string, string>;
  /** A placeholder for a secret: put it in a request's address, headers or body, and the gate puts the value in. */
  secret(name: string): string;
  /** A whole Authorization header for HTTP Basic sign-in with `user` and a secret as the password, filled in at the gate. */
  basic(user: string, secret: string): string;
  now: number;
  /** The owner's time zone. */
  tz: string;
  /** This extension's own address for posts, when it takes them. */
  address?: string;
  /** What the core shares for what the extension provides: the owner's saved places, for a location app. */
  data?: Json;
}

/** Something that happened, for the intake (§10.4). */
export interface Item {
  event: string;
  /** What happened, in a line: "GitHub: review requested on "Fix login" in acme/web". */
  what: string;
  /** The same key again within a while is the same news. */
  key?: string;
  /** The thing it belongs to: a mail thread, an issue. */
  thread?: string;
  /** Who it's from: "Doug Henderson <doug@acme.com>", or a handle. */
  from?: string;
  /** Who else it's with or about. */
  people?: string[];
  /** The service's own signals, for cheap rules: "review_requested", "newsletter". */
  signals?: string[];
  link?: string;
  /** The words as they came, from someone else: kept aside, read only as information. */
  raw?: string;
  /**
   * What it's about across sources, so the same news from two (a webhook and a look) counts once:
   * "github:acme/web#12:review_requested".
   */
  topic?: string;
  [field: string]: Json | undefined;
}

/** A message that came in on a channel. */
export interface Message {
  /** The channel's own id for it, so it's taken once. */
  id: string;
  /** Where to answer: the chat it came from. */
  chat: string;
  from: { id: string; name?: string; handle?: string };
  text?: string;
  /** A voice note, as audio. */
  voice?: { base64: string; type: string };
  /** A photo, as an image. */
  photo?: { base64: string; type: string; caption?: string };
  /** A button the person pressed, with what it carries. */
  button?: { data: string; message?: string };
  /** The message it replies to, when it's a reply. */
  reply_to?: string;
}

/** What the core sends on a channel. */
export interface Out {
  chat: string;
  text?: string;
  /** Buttons under the message: one that answers with `data`, or one that opens `url`. */
  buttons?: Array<{ label: string; data?: string; url?: string }>;
  reply_to?: string;
  file?: { name: string; type: string; base64: string };
  voice?: { base64: string; type: string };
  /** Shows that Atlas is typing, where the channel has that. */
  typing?: boolean;
  /** A reaction to a message instead of a reply. */
  react?: { message: string; emoji: string };
}

/** Mail to send. */
export interface Mail {
  from?: { address: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** The service's thread to keep it in, when it's a reply. */
  thread?: string;
  /** The Message-ID it answers, and the ones before it. */
  in_reply_to?: string;
  references?: string[];
  /** The Message-ID to send it with, when the core made one. */
  message_id?: string;
}

export interface EventPerson {
  name?: string;
  email?: string;
}

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

/** A contact from an address book. */
export interface Card {
  name: string;
  emails: string[];
  phones: string[];
  handles: Array<{ kind: "telegram" | "github" | "linear" | "handle"; value: string }>;
  details: Record<string, string>;
}

/** A position from a location app. */
export interface Fix {
  lat: number;
  lon: number;
  /** Accuracy in metres. */
  acc: number;
  at: number;
  /** Battery, 0 to 100. */
  batt?: number;
  charging?: boolean;
  conn?: "wifi" | "mobile" | "offline";
  /** Speed in km/h. */
  speed?: number;
  /** What the phone thinks you're doing: walking, automotive, stationary. */
  motion?: string[];
}

/** The phone saying it entered or left one of the owner's places (by the place's id), with where it was. */
export interface Transition {
  event: "enter" | "leave";
  place: string;
  fix: Fix;
}

export interface Point {
  lat: number;
  lon: number;
}

export interface Found extends Point {
  name: string;
  address: string;
  /** What kind of place it is, in the service's words ("supermarket"). */
  kind?: string;
  /** Metres from where the search was centred, or from the route. */
  m?: number;
  /** Minutes off the way, for places along a route. */
  detour_min?: number;
  hours?: string;
}

export interface Route {
  /** Seconds, with traffic when the provider has it. */
  s: number;
  m: number;
  traffic: boolean;
  /** The line to draw, [lon, lat] pairs, simplified. */
  line: Array<[number, number]>;
}

export type Travel = "drive" | "walk" | "bike";

/** A kind of place to look for: OpenStreetMap's tags for it (the shared language of map data) and the words for it. */
export interface Kind {
  osm: string[];
  words: string;
}

export interface Hour {
  t: number;
  temp_c: number;
  /** Chance of rain, percent. */
  pop: number;
  precip_mm: number;
  code: number;
  wind_kmh: number;
}

export interface Day {
  /** Local date, YYYY-MM-DD. */
  date: string;
  max_c: number;
  min_c: number;
  pop: number;
  code: number;
  uv: number;
}

export interface Weather {
  /** When it was fetched. */
  at: number;
  area: Point;
  now: { temp_c: number; feels_c: number; code: number; wind_kmh: number };
  /** The next 24 hours. */
  hours: Hour[];
  /** Today and the next six days. */
  days: Day[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** How old it is, or when it was published, when the search says. */
  age?: string;
}

export interface Request {
  method: string;
  headers: Record<string, string>;
  body: string;
  query: Record<string, string>;
}

export interface Received {
  items?: Item[];
  messages?: Message[];
  fixes?: Fix[];
  transitions?: Transition[];
  /** The answer to the post. A JSON answer for a location app can carry the owner's places. */
  reply?: { status?: number; body?: string; json?: Json; headers?: Record<string, string> };
  state?: Json;
}

/** The calls an extension can take. Each is optional; the core calls only the ones for what it provides. */
export interface Extension {
  manifest: Manifest;
  /** A live check for Settings: signs in and says what it found. `owner` names the owner's own addresses it learned. */
  test?(ctx: Ctx): Promise<{ text: string; owner?: { emails?: string[] }; state?: Json }>;
  /** After its secrets are set: anything it must do once, like telling a service its address. What it says is shown once. */
  setup?(ctx: Ctx): Promise<{
    text: string;
    link?: string;
    fields?: Array<{ label: string; value: string }>;
    /** DNS records the service needs on the owner's domain, which the core adds when it holds the domain's token. */
    records?: Array<{ type: string; name: string; content: string; priority?: number }>;
    state?: Json;
  }>;
  /** What's new since the cursor. */
  look?(ctx: Ctx): Promise<{ items: Item[]; cursor: Json; state?: Json }>;
  receive?(ctx: Ctx, req: Request): Promise<Received>;
  send?(ctx: Ctx, out: Out): Promise<{ id?: string }>;
  /** Sends mail; `message_id` is the Message-ID it went with, so replies can be matched to it. */
  mail?(ctx: Ctx, mail: Mail): Promise<{ id: string; thread?: string; link?: string; message_id?: string; state?: Json }>;
  calendar?(
    ctx: Ctx,
    range: { start: string; end: string; hidden: string[]; held?: boolean },
  ): Promise<{ events: CalendarEvent[]; as_of?: number; state?: Json; calendars?: string[] }>;
  /** Moves an event on the calendar to a new start and end (same forms as the event's), and says what it was before. */
  move?(ctx: Ctx, m: { id: string; start: string; end: string }): Promise<{ before: CalendarEvent; event: CalendarEvent; state?: Json }>;
  /** The address book: cards, or vCard text (RFC 6350), which the core reads. */
  contacts?(ctx: Ctx): Promise<{ cards?: Card[]; vcards?: string }>;
  geocode?(ctx: Ctx, q: { q: string; near?: Point }): Promise<Found[]>;
  reverse?(ctx: Ctx, p: Point): Promise<Found>;
  route?(ctx: Ctx, r: { via: Point[]; travel: Travel }): Promise<Route>;
  nearby?(
    ctx: Ctx,
    q: { kind?: Kind; name?: string; near: Point; along?: Array<[number, number]>; within: number; limit: number },
  ): Promise<Found[]>;
  weather?(ctx: Ctx, area: Point): Promise<Weather>;
  search?(ctx: Ctx, q: { query: string; count: number; fresh?: "day" | "week" | "month" | "year" }): Promise<SearchResult[]>;
}

/** A failure in the service's own words. `code` "auth" means the owner's sign-in or key was refused. */
export class Failure extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "network" | "protocol" | "refused" = "protocol",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Reads a JSON answer, or throws a Failure with the status, the host and what the service said. */
export async function json<T>(res: Response, who: string): Promise<T> {
  const host = asked.get(res) ?? (res.url ? new URL(res.url).host : "unknown host");
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const words = text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Failure(
      `${who} (${host}) answered ${res.status}${words ? `: ${words}` : ""}`,
      res.status === 401 || res.status === 403 ? "auth" : res.status >= 500 || res.status === 429 ? "network" : "protocol",
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Failure(`${who} (${host}) answered with something that isn't JSON: ${text.slice(0, 120)}`, "protocol", res.status);
  }
}

/** The host each answer came from, so a failure can name it even when the answer doesn't carry its address. */
const asked = new WeakMap<Response, string>();

let fetcher: typeof fetch = (input, init) => fetch(input, init);

/** Every request an extension makes, through the core's gate in its sandbox. Use this, or `get`, rather than `fetch`. */
export const http: typeof fetch = (input, init) => fetcher(input, init);

/** For the core's tests, which run an extension outside its sandbox: where its requests go instead. */
export function useFetch(f: typeof fetch): void {
  fetcher = f;
}

/** Fetches, turning a network failure into a Failure that names the host. */
export async function get(url: string, init: RequestInit = {}, who = new URL(url).host): Promise<Response> {
  try {
    const res = await http(url, init);
    asked.set(res, new URL(url).host);
    return res;
  } catch (err) {
    throw new Failure(`Couldn't reach ${who} (${new URL(url).host}): ${err instanceof Error ? err.message : String(err)}`, "network");
  }
}

/** Base64 of bytes, for files and audio. */
export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function bytesOf(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Text from a service, as one tidy line: tags gone, entities read, spaces squeezed, at most `n` characters. */
export function tidy(s: unknown, n = 400): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}
