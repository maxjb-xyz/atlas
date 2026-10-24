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
  | "search"
  /** A coding agent for jobs (§8.2): `agent` in its manifest says how the workspace runs it. */
  | "coding"
  /** Where the owner's code lives (§8.2): `git` in its manifest, and `repos`, `repo` and `pull_request`. */
  | "code"
  /**
   * Phone calls (§16.1): `call` in its manifest says how a call's audio streams; `numbers`, `use`, `release`,
   * `available` and `order` pick the number; `receive` takes the service's call events and answers them;
   * `dial` calls the owner.
   */
  | "calls"
  /** Tools Atlas can use in a turn, for a service with no MCP server of its own (§17): `tools` in its manifest, and `tool`. */
  | "tools";

/**
 * How a call's audio reaches Atlas (§16.1): the service connects to the
 * address the core gives (`data.stream`, plus `?call=`) and streams in the
 * media-stream protocol: JSON frames, `start`, then `media` with a base64
 * `payload` of G.711 μ-law at 8 kHz, then `stop`; Atlas answers with
 * `media` frames of the same and `clear` to drop what's queued.
 */
export interface CallSpec {
  protocol: "media-stream";
  codec: "pcmu";
  rate: 8000;
}

/** One of the account's phone numbers, and what its calls go to now. */
export interface PhoneNumber {
  id: string;
  /** E.164: "+15551234567". */
  number: string;
  /** What its voice is connected to now, by name, or null. */
  connected: string | null;
  /** It's the one Atlas uses. */
  ours: boolean;
  status: string;
}

/** A number the service would sell, with what it costs. */
export interface NumberOffer {
  number: string;
  where: string;
  monthly: string;
  upfront: string;
  currency: string;
}

/**
 * What the core shares with a calls extension: the owner's own numbers (a
 * call from one, with its caller ID verified by the network, is the owner),
 * the address to stream to, and what to say to anyone else.
 */
export interface CallData {
  owner_numbers: string[];
  stream: string;
  greeting: string;
}

/**
 * A coding agent (§8.2): an npm package with an ACP server, which the core
 * runs in the workspace for a job. The agent never holds its key: the core
 * points it at its model's address with a placeholder, and the workspace's
 * gate puts the key into its requests there.
 */
export interface CodingAgent {
  /** The npm package with its ACP server, pinned: "@agentclientprotocol/codex-acp@2.2.2". */
  package: string;
  /** More packages to install beside it, pinned: its own binary, so its version can't drift under a range. */
  with?: string[];
  /** The command the package installs. */
  bin: string;
  model: {
    /** Its model's address: "https://api.openai.com/v1". */
    url: string;
    /** The header the key goes in ("authorization", "x-api-key"), and what comes before it ("Bearer "). */
    header: string;
    prefix?: string;
    /** The key: one of this extension's secrets, or a sign-in the core holds (the owner's ChatGPT plan, §18). */
    key: { secret: string } | { signin: "chatgpt" };
  };
  /** Environment variables to start it with; "{url}" and "{key}" are filled with the model's address and a placeholder. */
  env?: Record<string, string>;
  /** It's told its model's address and key by ACP's gateway sign-in, not only its environment. */
  gateway?: boolean;
  /** The environment variable that points it at its own folder (its sessions), which the job keeps. */
  home?: string;
  /** The ACP mode a job runs in: the one that asks only about what matters, since Atlas answers. */
  mode?: string;
  /** It reports what it spends (ACP's usage with a cost), so a job can stop at a cap. */
  costs_money?: boolean;
  /** The environment variables that pick its model and how hard it thinks, when the owner picks them for a job. */
  choose?: { model?: string; effort?: string };
}

/** Where code lives (§8.2): how the workspace clones and pushes, with a token only the gate holds. */
export interface GitHost {
  /** The clone address, with {repo} for "owner/name": "https://github.com/{repo}.git". */
  clone: string;
  /** The hosts git talks to. */
  hosts: string[];
  /** The token is sent as HTTP Basic: this user name, and the secret as the password. */
  user: string;
  secret: string;
  /** A link to a branch, with {repo} and {branch}. */
  branch_link?: string;
}

/** A repository, as a code host lists it. */
export interface Repo {
  /** "owner/name". */
  repo: string;
  about?: string;
  default_branch: string;
  link: string;
  private?: boolean;
  /** When it last changed, ISO. */
  pushed_at?: string;
}

export interface SecretSpec {
  name: string;
  /** What to paste, in a few words: "A personal access token". */
  label: string;
  /** Where to get it, in a sentence or two. */
  help?: string;
  optional?: boolean;
  /**
   * How the core tidies what's pasted before keeping it, since the extension never sees the value:
   * spaces and dashes taken out, and when what's left matches `when` (a regular expression's source),
   * put back in groups of `group`, joined by `join`, lowercased if `lower`. An Apple app-specific
   * password pasted as "ABCD EFGH IJKL MNOP" is kept as Apple writes it, "abcd-efgh-ijkl-mnop".
   */
  tidy?: { when: string; group: number; join: string; lower?: boolean };
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

/**
 * What a tool does, which decides when Atlas asks first (VISION §12.1). The
 * core holds a tool to the kind it declares, whatever the tool does:
 * - "look" reads and changes nothing, so it runs at once;
 * - "change_own" changes the owner's own things in a way its `undo` tool
 *   takes back, so it runs at once and the receipt offers Undo (one that
 *   names no `undo` asks first, as one that speaks does);
 * - "speak" reaches other people or the public, so it asks until the owner
 *   trusts it;
 * - "irreversible" can't be undone (delete, cancel, submit), so it always
 *   asks, with a hold;
 * - "money" moves money, so it always asks, with a hold, showing the amount.
 */
export type ToolKind = "look" | "change_own" | "speak" | "irreversible" | "money";

/** A tool the extension offers Atlas (§17), run through its `tool` call. */
export interface ToolSpec {
  /** Lowercase letters, digits and underscores: "create_issue". Atlas sees it as `ext_<extension id>_<name>`. */
  name: string;
  /** What it does and when to use it, for the model: a tool's description is part of how Atlas behaves. */
  description: string;
  kind: ToolKind;
  /** Its input, as a JSON Schema object: { type: "object", properties: {...}, required: [...] }. */
  input: { type: "object"; properties?: Record<string, Json>; required?: string[]; [k: string]: Json | undefined };
  /**
   * For "change_own": the tool that takes it back, given the `undo` the call returned as its input. It runs on
   * the owner's Undo with no card, so it must be a "change_own" tool too (it can be this one).
   */
  undo?: string;
  /** For "money": the input fields that hold the amount and its currency, shown on the card. */
  amount?: string;
  currency?: string;
}

/** What a tool call gives back. The text is the service's words: Atlas reads it as information, never as instructions. */
export interface ToolOutput {
  text: string;
  /** What it made or changed, for the receipt. */
  link?: string;
  /** For a "change_own" tool: the input for its `undo` tool that takes this call back. */
  undo?: Json;
  state?: Json;
}

export interface Manifest {
  /** Lowercase, stable: "github", "icloud". */
  id: string;
  name: string;
  version: string;
  /** What it does, in a sentence the owner reads before installing it. */
  about: string;
  /**
   * The service's own logo for its card, used under the service's terms: a small SVG or PNG as a data URI
   * ("data:image/svg+xml;base64,…"). A bundled extension's comes from icon.svg or icon.png in its folder.
   */
  icon?: string;
  /** The logo is black, so the app inverts it in the dark theme. */
  icon_invert?: boolean;
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
  receives?: {
    signature?: Signature;
    claims?: string[];
    /**
     * A header the service sends back on every post, set to the address's own key (Telegram's secret
     * token): the core refuses a post without it.
     */
    token_header?: string;
  };
  /** The least time between two calls, for free services that ask to be called gently. */
  pace_ms?: number;
  /** What it costs while it's on, when that isn't nothing. */
  costs?: string;
  /** The credit its data needs wherever it's shown: "© OpenStreetMap contributors". */
  credit?: string;
  /** A coding agent's spec, when it provides "coding". */
  agent?: CodingAgent;
  /** How a call's audio streams, when it provides "calls". */
  call?: CallSpec;
  /** How git reaches it, when it provides "code". */
  git?: GitHost;
  /** The tools it offers Atlas, when it provides "tools". */
  tools?: ToolSpec[];
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
  /** Which of its secrets are set (never their values), so it can say what's missing instead of sending an empty one. */
  has?: string[];
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
  /** It was forwarded from someone else: their words, not the sender's. */
  forwarded?: { from?: string };
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
  /** Which account it's on (its extension's id), as Atlas reads it; an extension leaves it out. */
  account?: string;
}

/** A new event, as Atlas adds it (§10.1): no attendees, so adding one invites no one. */
export interface NewEvent {
  title: string;
  /** UTC ISO time, or a plain date when all_day. */
  start: string;
  /** Exclusive end, in the same form as `start`. */
  end: string;
  all_day: boolean;
  location?: string;
  notes?: string;
  /** Which of the account's calendars, by name; its first (or main) one when left out. */
  calendar?: string;
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
  /** Adds an event to one of the account's calendars, and says what it is now. */
  add?(ctx: Ctx, e: NewEvent): Promise<{ event: CalendarEvent; state?: Json }>;
  /** Removes an event (all of it, for a repeat), and says what it was. */
  remove?(ctx: Ctx, m: { id: string }): Promise<{ event: CalendarEvent; state?: Json }>;
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
  /** The owner's repositories, most recently changed first. */
  repos?(ctx: Ctx): Promise<Repo[]>;
  /** One repository. */
  repo?(ctx: Ctx, q: { repo: string }): Promise<Repo>;
  /** Opens a pull request from `head` into `base`, and says where it is. */
  pull_request?(
    ctx: Ctx,
    pr: { repo: string; head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; link: string }>;
  /** The account's phone numbers, and what each is connected to. */
  numbers?(ctx: Ctx): Promise<{ numbers: PhoneNumber[]; state?: Json }>;
  /** Moves one number's calls to Atlas, keeping what it was connected to for `release`. Says what it did. */
  use?(ctx: Ctx, q: { id: string }): Promise<{ text: string; number: string; state?: Json }>;
  /** Gives the number back: its calls go where they went before. */
  release?(ctx: Ctx): Promise<{ text: string; state?: Json }>;
  /** Numbers it would sell, with their prices. */
  available?(ctx: Ctx, q: { area?: string; country?: string }): Promise<NumberOffer[]>;
  /** Buys a number for Atlas. Says what happened, including checks the service still needs. */
  order?(ctx: Ctx, q: { number: string }): Promise<{ text: string; number?: string; state?: Json }>;
  /** Calls the owner. `call` goes on the stream's address, so Atlas knows which call it is. */
  dial?(ctx: Ctx, q: { to: string; call: string }): Promise<{ id: string; state?: Json }>;
  /** Runs one of the tools its manifest declares, with input that fits that tool's schema. */
  tool?(ctx: Ctx, call: { name: string; input: Record<string, Json> }): Promise<ToolOutput>;
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
