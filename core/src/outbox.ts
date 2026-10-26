// One way out (§4.4): every message from Atlas leaves through here. To the
// owner, it picks one channel (§14): the app when it's in view, a live call,
// a chat they're writing on, where the matter started, or else their list
// for its urgency; what can wait is held through quiet hours and focus, and
// something urgent that goes unseen moves down its list. Every delivery
// beyond the thread leaves a receipt in the log.
// A look that leaves Atlas (a web search's query, a page's address) passes
// the secrets scrubber and the public-query check here too. Sharing rules
// come with members and faces in M5.

import { type PushSubscriptionJSON, sendPush, vapidKeys } from "./push";
import { type Action } from "./approvals";
import type { Json, Sql } from "./store/db";
import { getItem } from "./store/agenda";
import { append, get as getRow, type LogRow, type Surface, type Undo } from "./store/log";
import { readSettings, secretValues } from "./store/settings";
import { getState, setState } from "./store/state";
import { getArea, getScope } from "./store/areas";
import { deleteRecord, findRecords } from "./store/records";
import { hostOf, iconHost, type LookOut, siteIcon } from "./web";
import type { BrowserDriver } from "./browser";
import { findServer, type McpClient, type McpResult, type McpServer, resultText } from "./mcp";
import { FIELDS, fillsOn, findEntry, hiddenValues, siteFor, touchEntry, valueOf } from "./vault";
import { quietUntil, shortLocal, startOfLocalDay, zoneOf } from "./time";
import { callWebhook, webhooks, webhookView } from "./webhooks";

export const HIDDEN = "[hidden]";
/** The longest a notification about another area waits for the owner's focus to move (§21.3). */
export const SCOPE_HOLD_MS = 12 * 3_600_000;

/** Replaces any stored secret that appears in outgoing text. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(HIDDEN);
  return out;
}

/** A street address: a number, a few words, and a street word ("1204 Lake Ave", "55 W. Church Street"). */
const ADDRESS =
  /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9'.-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl)\b\.?(?:\s*(?:apt|unit|suite|ste|#)\.?\s*[A-Za-z0-9-]+)?/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/**
 * A phone number as people write one: ten digits in groups ("(407) 555-0134",
 * "407.555.0134"), or an international number with its +. A run of digits
 * with no breaks isn't one: page addresses are full of timestamps and ids.
 */
/** Coordinates: where someone is, to within a street ("28.6024, -81.2001"). */
const COORDS = /-?\b\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]\d{2,4}(?:[\s.-]\d{2,4}){2,4}\b/;

const SECRET_FOUND = "one of the owner's secrets";

const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s.,]+/g, " ")
    .trim();

/**
 * The public-query check (§4.4): private details never go into a web
 * search or a page's address. Returns what was found, in words Atlas can
 * act on, or null. Private means one of the owner's secrets, an email
 * address, a phone number, or a street address Atlas keeps in a record,
 * or coordinates. Names, places and topics are not (decided with the owner,
 * 2026-10-22). With `places`, for the maps services only (§4.4), saved
 * addresses and coordinates may go.
 */
export function privateIn(sql: Sql, text: string, secrets: string[], o: { places?: boolean } = {}): string | null {
  let t = text;
  try {
    // In a page's address, + is a space and %40 is an @.
    if (/^https?:\/\//i.test(text)) t = decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    // Not URL-encoded; check it as it is.
  }
  const both = (re: RegExp) => re.test(t) || re.test(text);
  if (scrub(t, secrets) !== t || scrub(text, secrets) !== text) return SECRET_FOUND;
  if (both(EMAIL)) return "an email address";
  if (both(PHONE)) return "a phone number";
  if (o.places) return null;
  if (both(COORDS)) return "where you are (coordinates)";
  const q = ` ${squash(t)} `;
  for (const r of [...findRecords(sql, "person"), ...findRecords(sql, "place"), ...findRecords(sql, "organization")]) {
    for (const v of Object.values(r.fields)) {
      if (typeof v !== "string") continue;
      for (const a of v.matchAll(ADDRESS)) if (q.includes(` ${squash(a[0])} `)) return `a street address from what Atlas knows (${r.name})`;
    }
  }
  return null;
}

/**
 * The scrubber for streamed text. It holds back only a tail that could be
 * the start of a secret, so a secret split across two chunks is still caught
 * while ordinary text (almost always) goes straight out. Holding back a fixed
 * length instead would hold whole replies, since sign-in tokens run to
 * thousands of characters.
 */
export class StreamScrubber {
  private held = "";

  constructor(private readonly secrets: string[]) {}

  push(chunk: string): string {
    const all = scrub(this.held + chunk, this.secrets);
    const keep = this.partialTail(all);
    this.held = all.slice(all.length - keep);
    return all.slice(0, all.length - keep);
  }

  flush(): string {
    const rest = scrub(this.held, this.secrets);
    this.held = "";
    return rest;
  }

  /** The length of the longest end of `text` that is the beginning of a secret. */
  private partialTail(text: string): number {
    let best = 0;
    for (const s of this.secrets) {
      for (let k = Math.min(s.length - 1, text.length); k > best; k--) {
        // Cheap first-character check before comparing the whole stretch.
        if (text.charCodeAt(text.length - k) === s.charCodeAt(0) && text.endsWith(s.slice(0, k))) {
          best = k;
          break;
        }
      }
    }
    return best;
  }
}

/** Focus (§14): until when things that can wait are held, and what for. */
export interface Focus {
  until: number;
  about: string;
}

/** The focus in force now, or null. */
export function focusNow(sql: Sql, now = Date.now()): Focus | null {
  const f = getState<Focus>(sql, "focus");
  return f && f.until > now ? f : null;
}

/** Pushes for things that could wait, sent so far today in the owner's time zone. */
export function interruptionsToday(sql: Sql, tz: string, now = new Date()): number {
  return sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM log WHERE kind = 'delivery' AND at >= ? AND json_extract(body, '$.channel') IN ('push', 'chat')
         AND json_extract(body, '$.ok') = 1 AND json_extract(body, '$.to') IS NOT NULL AND json_extract(body, '$.urgency') IN ('normal', 'soon')`,
      startOfLocalDay(now, tz).getTime(),
    )
    .one().n;
}

/**
 * How urgent a message is, which Atlas decides with it (§14): "now" goes out
 * at once and moves down the list while unseen; "soon" waits for quiet hours
 * and focus to end, and counts against the day's budget; "later" waits in
 * the app for the next time the owner opens it.
 */
export type Urgency = "now" | "soon" | "later";

/** How long something urgent waits to be seen before the next place on its list (§14). */
export const FOLLOW_UP_MS = 5 * 60_000;
/** A chat the owner wrote on this recently is where they're talking now (§14). */
export const TALKING_MS = 10 * 60_000;

/** The chat the owner is talking on now: the one their last message came from, if it was in the last few minutes. */
export function talkingOn(sql: Sql, now = Date.now()): string | null {
  const r = sql
    .exec<{ ext: string | null; at: number }>(
      `SELECT json_extract(body, '$.channel') AS ext, at FROM log WHERE kind = 'message.in' AND actor = 'owner' ORDER BY seq DESC LIMIT 1`,
    )
    .toArray()[0];
  return r?.ext && now - r.at < TALKING_MS ? r.ext : null;
}

/**
 * Where the matter started (§14): the chat a job or a promise was asked for
 * on, from the run that made it. `trigger` is the run's, such as `job:ag_…`.
 */
export function askedOn(sql: Sql, trigger: string | undefined): string | null {
  const id = /^(?:job|agenda):(.+)$/.exec(trigger ?? "")?.[1];
  const run = id ? getItem(sql, id)?.source.run_id : null;
  if (!run) return null;
  const r = sql
    .exec<{ ext: string | null }>(
      `SELECT json_extract(body, '$.channel') AS ext FROM log WHERE run_id = ? AND kind = 'message.in' AND actor = 'owner' LIMIT 1`,
      run,
    )
    .toArray()[0];
  return r?.ext ?? null;
}

/** The places to try, in order (§14): the chat the owner is talking on, where the matter started, then their list. */
export function route(sql: Sql, urgency: "now" | "soon", origin?: string | null): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && !out.includes(c)) out.push(c);
  };
  add(talkingOn(sql));
  add(origin);
  for (const c of readSettings(sql).notifications.lists[urgency]) add(c);
  return out;
}

export interface Delivery {
  text: string;
  run_id: string | null;
  /** Where the owner gets it: the surface they asked on, or "app" for something Atlas starts. */
  channel: Surface;
  urgency?: Urgency;
  brain?: { provider: string; model: string } | null;
  fallback?: boolean;
  interrupted?: boolean;
  usage?: unknown;
  trigger?: string;
  /** The chat the matter started on (§14), when it didn't start in the app. */
  origin?: string | null;
  /** A nudge Atlas sent on its own (§10.3): what started it, what it was about in Atlas's words, and the errand or thing, if any. */
  nudge?: { from: string; about: string; ref?: string };
  /** For spoken replies: when the status line and the answer were ready. */
  timing?: Record<string, unknown>;
  /**
   * One place it always goes ("push", a linked chat like "telegram"), as an automation's report can ask (§13.3),
   * whether or not Atlas is open; "you" or none follows the Notifications lists.
   */
  to?: string;
}

/** One of the owner's devices that takes push notifications. */
export interface PushDevice {
  id: string;
  name: string;
  sub: PushSubscriptionJSON;
  /** The app's address on that device, which the push services are told is the sender. */
  origin: string;
  added_at: number;
  last_seen: number;
}

/** What a push is about: a message in the log, or something with no row of its own (a test, an approval). */
export interface Note {
  id: string;
  run_id: string | null;
  text: string;
}

const noteOf = (row: LogRow): Note => ({ id: row.id, run_id: row.run_id, text: String(row.body.text ?? "") });

export const pushDevices = (sql: Sql): PushDevice[] => getState<PushDevice[]>(sql, "push_devices") ?? [];

/** The live ends of each channel. The agent provides them. */
export interface Channels {
  /** Every open app connection. */
  broadcast(rows: LogRow[]): void;
  /** Speaks into a live call, if there is one. Resolves false when nobody is in a call. */
  speak(text: string): Promise<boolean>;
  /** Whether the owner has Atlas open and in view on some device right now. */
  looking(): boolean;
  /** Puts a held notification on the one clock (§4.3), to be released at `at`. */
  /** Holds a notification on the clock until `at`; `why` "scope" ones go out as soon as the owner's focus moves. */
  hold(at: Date, note: Note, why?: "scope"): Promise<void>;
  /** Puts a follow-up on the clock (§14): at `at`, if the owner hasn't been seen since, `note` goes to the next of `rest`. */
  followUp?(at: Date, note: Note, rest: string[]): Promise<void>;
  fetch: typeof fetch;
  /** The browser (§9.1), or null where there isn't one. */
  browser(): BrowserDriver | null;
  /** Connected MCP servers (§9.2), or null where there's no client. */
  mcp(): McpClient | null;
  /** Sends a call to a paired device (§16.3) and waits for its answer; `offline` when it isn't connected. */
  node?(c: { node: string; tool: string; input: Record<string, unknown> }): Promise<{ ok: boolean; text: string; offline?: boolean }>;
  /**
   * Sends a mail (§16.2): as the owner through the extension that holds
   * their mail, or as Atlas from its own address. The provider's own words
   * come back when it fails.
   */
  mail?(
    a: Extract<Action, { kind: "email" }>,
  ): Promise<
    { ok: true; id: string; thread?: string; link?: string; message_id?: string; via: string } | { ok: false; error: string; via: string }
  >;
  /**
   * Sends a message to the owner on a chat channel they've linked (§16.1); false when it isn't linked.
   * An approval card goes with its Approve and Decline buttons (or a link to the app, when it needs a hold),
   * so a tap decides it and nothing rests on reading a typed "yes".
   */
  chat?(ext: string, text: string, card?: { approval: string; hold: boolean }): Promise<boolean>;
  /** Calls the owner to say it (§16.1), when they've allowed calls; throws with why it couldn't. */
  call?(text: string): Promise<boolean>;
  /** Sends a face's answer in the owner's name, once they've OK'd it (§7.2). */
  faceReply?(a: Extract<Action, { kind: "face_reply" }>): Promise<{ ok: boolean; text: string }>;
  /** Opens a coding job's pull request on its code host (§8.2), and says where. */
  pullRequest?(a: Extract<Action, { kind: "pull_request" }>): Promise<{ number: number; link: string }>;
  /** Puts a call to an offline device on the clock, to run when it's back. */
  later?(c: {
    node: string;
    device: string;
    tool: string;
    input: Record<string, unknown>;
    run_id: string | null;
    by: string;
  }): Promise<boolean>;
  /** Runs an extension's tool in its sandbox (§17), and gives back what it said, in the service's words when it fails. */
  extTool?(c: { ext: string; tool: string; input: Record<string, unknown> }): Promise<ExtToolOut>;
}

/** What an extension's tool gave back: its words, a link to what it made, and the input that takes it back. */
export interface ExtToolOut {
  text: string;
  link?: string;
  undo?: Json;
}

export class Outbox {
  constructor(
    private readonly sql: Sql,
    private readonly channels: Channels,
  ) {}

  secrets(): string[] {
    return secretValues(this.sql);
  }

  /**
   * Saves and sends one message to the owner. A reply is already streamed on
   * the surface that asked, so it's saved and shown. Something Atlas starts
   * on its own (a reminder) goes out loud when the owner is in a call. When
   * no app is in view, a push goes to the device used last. Returns the
   * message's row.
   */
  async deliver(d: Delivery, opts: { alreadyStreamed: boolean }): Promise<LogRow> {
    const text = scrub(d.text, this.secrets());
    let channel = d.channel;
    if (!opts.alreadyStreamed && (await this.channels.speak(text))) channel = "voice";
    const row = append(this.sql, {
      actor: "atlas",
      kind: "message.out",
      run_id: d.run_id,
      surface: channel,
      body: {
        text,
        channel,
        ...(d.brain ? { brain: d.brain } : {}),
        ...(d.fallback ? { fallback: true } : {}),
        ...(d.interrupted ? { interrupted: true } : {}),
        ...(d.usage ? { usage: d.usage as never } : {}),
        ...(d.trigger ? { trigger: d.trigger } : {}),
        ...(d.nudge ? { nudge: d.nudge } : {}),
        ...(d.timing ? { timing: d.timing as never } : {}),
      },
    });
    this.channels.broadcast([row]);
    // Asked for one place: it goes there; if that place can't take it now, the lists decide as usual.
    if (d.to && d.to !== "you" && channel !== "voice") {
      const urgency = d.urgency === "now" ? "now" : "soon";
      if (await this.#via(d.to, [noteOf(row)], urgency).catch(() => false)) return row;
      this.receipt(row.run_id, {
        of: [row.id],
        channel: d.to,
        ok: false,
        urgency,
        note: `${d.to === "push" ? "No device took the notification" : "That chat didn't take it"}, so it went the usual way.`,
      });
    }
    // One channel (§14): heard in a call, or seen in an app in view, needs no push as well.
    if (channel !== "voice" && channel !== "api" && channel !== "chat" && !this.channels.looking())
      await this.notify(noteOf(row), d.urgency ?? "soon", undefined, d.origin);
    return row;
  }

  /**
   * Tells the owner about something they haven't seen, in one place (§14).
   * `extra` goes to the service worker with a push; `origin` is the chat the
   * matter started on.
   */
  async notify(row: Note, urgency: Urgency, extra?: Record<string, unknown>, origin?: string | null): Promise<void> {
    const settings = readSettings(this.sql);
    if (urgency === "later") {
      this.receipt(row.run_id, {
        of: [row.id],
        channel: "app",
        ok: true,
        urgency,
        note: "It waits in the app, for when you next open it.",
      });
      return;
    }
    const tz = zoneOf(settings);
    const quiet = urgency === "now" ? null : quietUntil(new Date(), tz, settings.notifications.quiet);
    const focus = urgency === "now" ? null : focusNow(this.sql);
    const until = Math.max(quiet?.getTime() ?? 0, focus?.until ?? 0);
    if (until) {
      const why = quiet && quiet.getTime() >= until ? "quiet hours" : `focus${focus!.about ? ` (${focus!.about})` : ""}`;
      await this.channels.hold(new Date(until), row);
      this.receipt(row.run_id, {
        of: [row.id],
        channel: "push",
        ok: true,
        held_until: until,
        note: `Held for ${why}, until ${shortLocal(new Date(until), tz)}.`,
      });
      return;
    }
    // Focused on an area (§21.3), what's about another one waits until the focus moves, unless it's urgent.
    const scope = urgency === "now" ? null : getScope(this.sql);
    const areas = scope ? (getRow(this.sql, row.id)?.areas ?? []) : [];
    if (scope && areas.length && !areas.includes(scope)) {
      await this.channels.hold(new Date(Date.now() + SCOPE_HOLD_MS), row, "scope");
      this.receipt(row.run_id, {
        of: [row.id],
        channel: "push",
        ok: true,
        held_until: Date.now() + SCOPE_HOLD_MS,
        note: `Held while you're focused on ${getArea(this.sql, scope)?.name ?? "another area"}; it goes out when you switch back.`,
      });
      return;
    }
    if (urgency === "soon" && this.#overBudget([row])) return;
    await this.reach([row], urgency, route(this.sql, urgency, origin), extra);
  }

  /**
   * Tries each place in turn until one takes it. Something now then waits
   * to be seen, and if it isn't, the clock sends it to the next (§14).
   * True when one took it.
   */
  async reach(rows: Note[], urgency: "now" | "soon", places: string[], extra?: Record<string, unknown>): Promise<boolean> {
    for (let i = 0; i < places.length; i++) {
      if (!(await this.#via(places[i]!, rows, urgency, extra))) continue;
      const rest = places.slice(i + 1);
      if (urgency === "now" && rest.length && this.channels.followUp)
        await this.channels.followUp(new Date(Date.now() + FOLLOW_UP_MS), rows[0]!, rest);
      return true;
    }
    return false;
  }

  /** One place: a push to the device used last, or a linked chat. */
  async #via(place: string, rows: Note[], urgency: "now" | "soon", extra?: Record<string, unknown>): Promise<boolean> {
    if (place === "push") {
      if (!readSettings(this.sql).notifications.push || !pushDevices(this.sql).length) return false;
      return (await this.push(rows, urgency, { extra })).ok;
    }
    const text = rows.map((r) => r.text).join("\n\n");
    // A call is only for what can't wait (§14), and only once the owner allowed it (§12.3).
    if (place === "call") {
      if (urgency !== "now" || !this.channels.call) return false;
      let error = "";
      const ok = await this.channels.call(text).catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        return false;
      });
      if (ok || error)
        this.receipt(rows[0]!.run_id, { of: rows.map((r) => r.id), channel: "call", ok, urgency, ...(error ? { error } : {}) });
      return ok;
    }
    if (!this.channels.chat) return false;
    let error = "";
    const approval = typeof extra?.approval === "string" ? extra.approval : null;
    const card = approval && rows.length === 1 ? { approval, hold: extra?.hold === true } : undefined;
    const ok = await this.channels.chat(place, text, card).catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
      return false;
    });
    if (ok || error)
      this.receipt(rows[0]!.run_id, { of: rows.map((r) => r.id), channel: "chat", to: place, ok, urgency, ...(error ? { error } : {}) });
    return ok;
  }

  /** Past the day's budget, something that can wait doesn't go out: it waits in the app, and the receipt says so. */
  #overBudget(rows: Note[]): boolean {
    const settings = readSettings(this.sql);
    const budget = settings.notifications.budget;
    if (!budget || interruptionsToday(this.sql, zoneOf(settings)) < budget) return false;
    this.receipt(rows[0]!.run_id, {
      of: rows.map((r) => r.id),
      channel: "push",
      ok: true,
      note: `Not sent: today's ${budget} interruptions are used. It waits in the app.`,
    });
    return true;
  }

  /** Notifications held through quiet hours: together, in one place, unless the owner has opened Atlas since. */
  async release(rows: Note[]): Promise<void> {
    if (!rows.length) return;
    if (this.channels.looking()) {
      this.receipt(rows[0]!.run_id, { of: rows.map((r) => r.id), channel: "push", ok: true, note: "Not sent: you had Atlas open." });
      return;
    }
    if (this.#overBudget(rows)) return;
    await this.reach(rows, "soon", route(this.sql, "soon"));
  }

  /**
   * One push for `rows`, to the device used last; if that one fails, the
   * next. A device the push service says is gone is forgotten, with the
   * reason in the receipt. `device` sends to that one only (Settings' test);
   * `extra` adds to what the service worker gets, such as an approval to
   * offer an Approve button for.
   */
  async push(
    rows: Note[],
    urgency: Urgency,
    o: { device?: string; extra?: Record<string, unknown> } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const device = o.device;
    const devices = pushDevices(this.sql)
      .filter((d) => !device || d.id === device)
      .sort((a, b) => b.last_seen - a.last_seen);
    if (!devices.length)
      return { ok: false, error: device ? "This device isn't set up for notifications." : "No device takes notifications." };
    const settings = readSettings(this.sql);
    const keys = await vapidKeys(this.sql);
    const first = rows[0]!;
    const words = (r: Note) => r.text.replace(/\s+/g, " ").trim();
    const payload = {
      title: settings.assistant_name,
      body: rows.length === 1 ? clip(words(first), 240) : `${rows.length} messages. The first: ${clip(words(first), 180)}`,
      tag: first.id,
      url: "/",
      ...(o.extra ?? {}),
    };
    let error = "";
    for (const d of devices) {
      const out = await sendPush(this.channels.fetch, d.sub, payload, {
        keys,
        subject: d.origin.startsWith("https://") ? d.origin : "mailto:atlas@example.invalid",
        urgency: urgency === "now" ? "high" : "normal",
        ttl: 24 * 3600,
      });
      if (out.ok) {
        this.receipt(first.run_id, { of: rows.map((r) => r.id), channel: "push", to: d.name, ok: true, urgency });
        return { ok: true };
      }
      error = out.gone ? `${out.error}. That device stopped taking notifications, so Atlas forgot it.` : (out.error ?? "It failed.");
      if (out.gone)
        setState(
          this.sql,
          "push_devices",
          pushDevices(this.sql).filter((x) => x.id !== d.id),
        );
      this.receipt(first.run_id, { of: rows.map((r) => r.id), channel: "push", to: d.name, ok: false, error, urgency });
      console.error(JSON.stringify({ at: "push", device: d.name, status: out.status, error }));
    }
    return { ok: false, error };
  }

  /**
   * A look that leaves Atlas (§4.4): a web search's query or a page's
   * address goes to someone else's server, so it passes the exit checks
   * first. Something private in it stops it with the reason, and nothing is
   * sent. Either way a delivery receipt says what went where, and how it
   * went: the status, the host and on failure the service's own words.
   */
  async look<T>(
    o: {
      what: LookWhat;
      text: string;
      to: string;
      run_id: string | null;
      /** Maps and weather have channels of their own; the web is the default. */
      channel?: "web" | "maps" | "weather";
    },
    go: (f: typeof fetch) => Promise<LookOut<T>>,
  ): Promise<LookOut<T>> {
    const base = { channel: o.channel ?? "web", what: o.what, to: o.to, text: clip(o.text, 500) };
    // Places may go to the maps services and nowhere else (§4.4); weather gets a rough area, checked by its caller.
    const found = privateIn(this.sql, o.text, this.secrets(), { places: o.channel === "maps" || o.channel === "weather" });
    if (found) {
      const error = `Not sent: it held ${found}. Private details never go into ${WHERE[o.what]}.`;
      const secret = found === SECRET_FOUND;
      this.receipt(o.run_id, {
        ...base,
        ...(secret ? { text: scrub(base.text, this.secrets()) } : {}),
        ok: false,
        error,
        checks: secret ? { secrets: "failed" } : { secrets: "passed", public_query: "failed" },
      });
      return { ok: false, status: 0, error };
    }
    const out = await go(this.channels.fetch).catch((err: unknown): LookOut<T> => ({
      ok: false,
      status: 0,
      error: `Couldn't reach ${o.to}: ${err instanceof Error ? err.message : String(err)}`,
    }));
    this.receipt(o.run_id, {
      ...base,
      ok: out.ok,
      status: out.status,
      ...(out.ok ? (out.note ? { note: out.note } : {}) : { error: out.error }),
      checks: { secrets: "passed", public_query: "passed" },
    });
    if (!out.ok) console.error(JSON.stringify({ at: `web.${o.what}`, to: o.to, status: out.status, error: out.error }));
    return out;
  }

  /**
   * A site's icon, for a source shown in the thread (M7 W17). Only a public host leaves, one Atlas already read or
   * found in a search, so there's nothing to check it for and no receipt: the look that found the site has one.
   */
  async icon(host: string): Promise<{ type: string; bytes: ArrayBuffer } | null> {
    if (!iconHost(host)) return null;
    return siteIcon(this.channels.fetch, host).catch(() => null);
  }

  /**
   * Does what the owner's OK (or earned trust, or the owner's own button)
   * allowed. The exit checks run first; a webhook call leaves a delivery
   * receipt with what it answered. `by` says whose word it went out on.
   */
  async perform(
    a: Action,
    o: { run_id: string | null; by: "approved" | "trusted" | "owner" | "automation" },
  ): Promise<{ ok: boolean; text: string; undo?: Undo }> {
    if (a.kind === "browser") return this.#submit(a, o);
    if (a.kind === "mcp") {
      const out = await this.mcp({ server: a.server, tool: a.tool, args: a.arguments, run_id: o.run_id, by: o.by });
      return {
        ok: out.ok,
        text: out.ok ? `${a.name} answered: ${clip(out.text, 4_000)}` : `${a.name} didn't work: ${clip(out.text, 1_000)}`,
      };
    }
    if (a.kind === "mcp_add") return this.#connect(a, o);
    if (a.kind === "tool") {
      const out = await this.extTool({ ext: a.ext, tool: a.tool, name: a.name, input: a.input, undo: a.undo }, o);
      return {
        ok: out.ok,
        text: out.ok ? `${a.name} answered: ${clip(out.text, 4_000)}` : `${a.name} didn't work: ${clip(out.text, 1_000)}`,
        ...(out.undo ? { undo: out.undo } : {}),
      };
    }
    if (a.kind === "email") return this.#mail(a, o);
    if (a.kind === "pull_request") {
      if (!this.channels.pullRequest) return { ok: false, text: "Pull requests can't be opened from here." };
      if (scrub(`${a.title}\n${a.body}`, this.secrets()) !== `${a.title}\n${a.body}`)
        return { ok: false, text: "The pull request's words held one of your secrets, so it wasn't opened." };
      try {
        const pr = await this.channels.pullRequest(a);
        this.receipt(o.run_id, {
          channel: "code",
          to: a.repo,
          text: a.title,
          link: pr.link,
          by: o.by,
          ok: true,
          checks: { secrets: "passed" },
        });
        return { ok: true, text: pr.link };
      } catch (err) {
        const text = `Couldn't open the pull request on ${a.repo}: ${err instanceof Error ? err.message : String(err)}`;
        this.receipt(o.run_id, { channel: "code", to: a.repo, text: a.title, by: o.by, ok: false, error: text });
        return { ok: false, text };
      }
    }
    if (a.kind === "face_reply") {
      if (!this.channels.faceReply) return { ok: false, text: "A face's answer can't be sent from here." };
      if (scrub(a.text, this.secrets()) !== a.text) return { ok: false, text: "The answer held one of your secrets, so it wasn't sent." };
      const out = await this.channels
        .faceReply(a)
        .catch((err: unknown) => ({ ok: false, text: err instanceof Error ? err.message : String(err) }));
      this.receipt(o.run_id, {
        channel: "face",
        to: a.name,
        text: a.text.slice(0, 300),
        by: o.by,
        ok: out.ok,
        ...(out.ok ? {} : { error: out.text }),
      });
      return out;
    }
    if (a.kind === "node") return this.device({ node: a.node, device: a.device, tool: a.tool, input: a.input }, o);
    if (a.kind === "vault") return this.#fill(a, o);
    if (a.kind === "site") {
      const sites = getState<string[]>(this.sql, "workspace_sites") ?? [];
      setState(this.sql, "workspace_sites", [...new Set([...sites, a.host])]);
      if (a.key) touchEntry(this.sql, a.key.entry, (x) => ({ ...x, allowed: [...new Set([...x.allowed, siteFor(x, a.host)])] }));
      this.receipt(o.run_id, { channel: "workspace", to: a.host, text: a.name, by: o.by, ok: true, note: "Allowed from now on." });
      return { ok: true, text: `The workspace can reach ${a.host} now${a.key ? `, carrying ${a.key.name}` : ""}.` };
    }
    if (a.kind === "delete") {
      const touched = deleteRecord(this.sql, a.record, { via: "owner", ...(o.run_id ? { run_id: o.run_id } : {}) });
      // Open apps get the blanked rows at once, so the deleted words don't linger on screen.
      if (touched?.length) this.channels.broadcast(touched.map((id) => getRow(this.sql, id)).filter((r): r is LogRow => r != null));
      return { ok: touched != null, text: touched ? `Deleted ${a.name} for good.` : `${a.name} was already gone.` };
    }
    const hook = webhooks(this.sql).find((w) => w.id === a.webhook);
    const base = { channel: "webhook", by: o.by, ...(a.message ? { text: a.message } : {}) };
    if (!hook) {
      const text = `The webhook ${a.name} isn't there any more, so it wasn't called.`;
      this.receipt(o.run_id, { ...base, to: a.name, ok: false, error: text });
      return { ok: false, text };
    }
    const to = `${hook.name} · ${webhookView(hook).host}`;
    if (a.message && scrub(a.message, this.secrets()) !== a.message) {
      const text = `${hook.name} wasn't called: the message held one of your secrets.`;
      this.receipt(o.run_id, { ...base, to, ok: false, error: text, checks: { secrets: "failed" } });
      return { ok: false, text };
    }
    const out = await callWebhook(this.channels.fetch, hook, { message: a.message, from: readSettings(this.sql).assistant_name });
    this.receipt(o.run_id, {
      ...base,
      to,
      ok: out.ok,
      status: out.status,
      ...(out.ok ? { answer: out.answer } : { error: out.answer }),
      ...(out.reply ? { reply: out.reply } : {}),
      checks: { secrets: "passed", ok: o.by },
    });
    if (!out.ok) console.error(JSON.stringify({ at: "webhook", name: hook.name, error: out.answer }));
    return { ok: out.ok, text: out.ok ? `Called ${hook.name}: ${out.answer}.` : `${hook.name} didn't work: ${out.answer}.` };
  }

  /**
   * Calls a tool on a connected MCP server (§9.2): a look when the server
   * says it only reads, else what the owner's OK or earned trust allowed.
   * Its arguments pass the secrets check first. A delivery receipt keeps the
   * server, the tool, how it went and, on failure, the server's own words.
   */
  async mcp(o: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    run_id: string | null;
    by: string;
  }): Promise<{ ok: boolean; text: string; result?: McpResult; server?: McpServer }> {
    const base = { channel: "mcp", to: o.server, text: o.tool, by: o.by };
    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      this.receipt(o.run_id, { ...base, ok: false, error, ...extra });
      console.error(JSON.stringify({ at: "mcp.call", server: o.server, tool: o.tool, error }));
      return { ok: false, text: error };
    };
    const client = this.channels.mcp();
    if (!client) return fail("This deployment has no MCP client.");
    const s = findServer(client.servers(), o.server);
    if (!s) return fail(`There's no connected server called ${o.server}.`);
    if (s.state !== "ready") {
      return fail(
        s.state === "authenticating"
          ? `${s.name} is waiting for the owner to sign in, in Settings → Connections → MCP servers.`
          : `${s.name} isn't ready (${s.state})${s.error ? `: ${s.error}` : ""}.`,
      );
    }
    const args = JSON.stringify(o.args);
    if (scrub(args, this.secrets()) !== args) {
      return fail(`Not sent: what it would send to ${s.name} held one of your secrets.`, { checks: { secrets: "failed" } });
    }
    try {
      const result = await client.call(s.id, o.tool, o.args);
      const text = resultText(result);
      const ok = !result.isError;
      this.receipt(o.run_id, {
        ...base,
        to: s.name,
        ok,
        ...(ok ? { answer: clip(text, 300) } : { error: clip(text, 1_000) }),
        checks: { secrets: "passed" },
      });
      if (!ok) console.error(JSON.stringify({ at: "mcp.call", server: s.name, tool: o.tool, error: clip(text, 1_000) }));
      return { ok, text, result, server: s };
    } catch (err) {
      return fail(`${s.name} (${hostOf(s.url)}) didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Runs an extension's tool (§17): a look at once, or what its kind, the
   * owner's OK or earned trust allowed. Its input passes the secrets check
   * first. A delivery receipt keeps the extension, the tool, how it went and,
   * on failure, the service's own words. When the tool names an `undo` and
   * the call gave its input back, the Undo comes back too. `undo_of` marks
   * this call as the undo of a receipt, once it works.
   */
  async extTool(
    c: { ext: string; tool: string; name: string; input: Record<string, unknown>; undo?: string },
    o: { run_id: string | null; by: string; undo_of?: string },
  ): Promise<{ ok: boolean; text: string; link?: string; undo?: Undo }> {
    const base = { channel: "extension", to: c.ext, text: c.tool, by: o.by };
    const fail = (error: string, extra: Record<string, unknown> = {}) => {
      this.receipt(o.run_id, { ...base, ok: false, error, ...extra });
      console.error(JSON.stringify({ at: "ext.tool", ext: c.ext, tool: c.tool, error }));
      return { ok: false, text: error };
    };
    if (!this.channels.extTool) return fail("Extensions' tools can't be used from here.");
    const input = JSON.stringify(c.input);
    if (scrub(input, this.secrets()) !== input)
      return fail(`Not sent: what it would send to ${c.ext} held one of your secrets.`, { checks: { secrets: "failed" } });
    let out: ExtToolOut;
    try {
      out = await this.channels.extTool({ ext: c.ext, tool: c.tool, input: c.input });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const text = typeof out?.text === "string" ? out.text : JSON.stringify(out ?? null);
    const link = typeof out?.link === "string" && /^https:\/\//.test(out.link) ? out.link : undefined;
    this.receipt(o.run_id, {
      ...base,
      ok: true,
      answer: clip(text, 300),
      ...(link ? { link } : {}),
      ...(o.undo_of ? { undo_of: o.undo_of } : {}),
      checks: { secrets: "passed" },
    });
    const undo: Undo | undefined =
      c.undo && out?.undo !== undefined && out.undo !== null
        ? { kind: "tool.undo", ext: c.ext, tool: c.undo, name: c.name, input: out.undo as Json }
        : undefined;
    return { ok: true, text: clip(text, 16_000), ...(link ? { link } : {}), ...(undo ? { undo } : {}) };
  }

  /**
   * A call to a paired device (§16.3). The secrets check first; then the
   * device, now when it's online, else on the clock until it's back. A
   * delivery receipt keeps the device, the tool and its answer.
   */
  async device(
    c: { node: string; device: string; tool: string; input: Record<string, unknown> },
    o: { run_id: string | null; by: string },
  ): Promise<{ ok: boolean; text: string; queued?: boolean }> {
    const base = { channel: "node", to: c.device, text: c.tool, by: o.by };
    const input = JSON.stringify(c.input);
    // A link or a command can carry a private detail off the device as surely as a search can (§4.4).
    const found = privateIn(this.sql, input, this.secrets());
    if (found) {
      const secret = found === SECRET_FOUND;
      this.receipt(o.run_id, {
        ...base,
        ok: false,
        error: `Not sent: it held ${found}.`,
        checks: secret ? { secrets: "failed" } : { secrets: "passed", public_query: "failed" },
      });
      return { ok: false, text: `Not sent to ${c.device}: it held ${found}. Private details don't go into a device's links or commands.` };
    }
    if (!this.channels.node || !this.channels.later) return { ok: false, text: "This deployment can't reach paired devices." };
    const out = await this.channels.node(c);
    if (out.offline) {
      if (!(await this.channels.later({ ...c, run_id: o.run_id, by: o.by }))) {
        this.receipt(o.run_id, { ...base, ok: false, error: "That device isn't paired any more." });
        return { ok: false, text: `${c.device} isn't paired any more, so nothing was sent.` };
      }
      this.receipt(o.run_id, { ...base, ok: true, note: "Waiting: the device is offline, so it runs when it's back." });
      return { ok: true, queued: true, text: `${c.device} is offline. It runs when it's back, and the owner hears how it went.` };
    }
    this.receipt(o.run_id, {
      ...base,
      ok: out.ok,
      ...(out.ok ? { answer: clip(out.text, 300) } : { error: clip(out.text, 1_000) }),
      checks: { secrets: "passed" },
    });
    if (!out.ok) console.error(JSON.stringify({ at: "node.call", device: c.device, tool: c.tool, error: clip(out.text, 1_000) }));
    return out;
  }

  /** Connects an MCP server once the owner said yes (§9.2). An OAuth server then waits for the owner to sign in. */
  async #connect(
    a: Extract<Action, { kind: "mcp_add" }>,
    o: { run_id: string | null; by: string },
  ): Promise<{ ok: boolean; text: string }> {
    const base = { channel: "mcp", what: "connect", to: a.name, text: a.url, by: o.by };
    const client = this.channels.mcp();
    if (!client) return { ok: false, text: "This deployment has no MCP client." };
    try {
      const r = await client.add({ name: a.name, url: a.url });
      const tools = client.servers().find((s) => s.id === r.id)?.tools.length ?? 0;
      const text =
        r.state === "authenticating"
          ? `${a.name} is added. Sign in to finish: ${r.auth_url ?? "Settings → Connections → MCP servers has Sign in"}`
          : `Connected ${a.name}, with ${tools} tool${tools === 1 ? "" : "s"}.`;
      this.receipt(o.run_id, { ...base, ok: true, answer: r.state === "authenticating" ? "Waiting for sign-in" : `${tools} tools` });
      return { ok: true, text };
    } catch (err) {
      const error = `${a.name} (${hostOf(a.url)}) didn't connect: ${err instanceof Error ? err.message : String(err)}`.replace(
        /\.\.$/,
        ".",
      );
      this.receipt(o.run_id, { ...base, ok: false, error });
      console.error(JSON.stringify({ at: "mcp.add", url: a.url, error }));
      return { ok: false, text: error };
    }
  }

  /**
   * Sends a form in the browser, once the owner said yes. Only on the page
   * it was asked on, and only if the button or field is still the one the
   * card showed; otherwise nothing is sent and the receipt says why.
   */
  async #submit(a: Extract<Action, { kind: "browser" }>, o: { run_id: string | null; by: string }): Promise<{ ok: boolean; text: string }> {
    const host = hostOf(a.url);
    const base = { channel: "browser", to: host, text: a.name, by: o.by };
    const fail = (error: string) => {
      this.receipt(o.run_id, { ...base, ok: false, error });
      console.error(JSON.stringify({ at: "browser.submit", host, error }));
      return { ok: false, text: `${a.name} didn't happen: ${error}` };
    };
    const driver = this.channels.browser();
    if (!driver) return fail("This deployment has no browser.");
    const here = driver.where();
    if (!here.open) return fail("The browser closed before your OK (it closes after ten minutes without use). Ask Atlas to do it again.");
    if (here.url !== a.url) return fail(`The browser moved on to ${here.url} since you were asked, so nothing was sent.`);
    try {
      const el = await driver.find(a.ref);
      if (!el || el.text !== a.what) return fail("The page changed since you were asked, so nothing was sent. Ask Atlas to do it again.");
      const page = await driver.act({ act: "submit", ref: a.ref });
      this.receipt(o.run_id, { ...base, ok: true, answer: `Now on ${page.title || hostOf(page.url)}` });
      return { ok: true, text: `Sent it on ${host}. The page now says: ${page.title || page.url}.` };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The vault's last step (§15): fills an entry's values into the browser's
   * fields, and presses the button after if asked. Only on a site the entry
   * is tied to, and only on the page it was asked on. The values never come
   * back: the receipt and the answer name the fields, and the page's title
   * has any vault value hidden. A yes from the owner is remembered for that
   * site, except for a card, which asks every time.
   */
  async #fill(a: Extract<Action, { kind: "vault" }>, o: { run_id: string | null; by: string }): Promise<{ ok: boolean; text: string }> {
    const base = { channel: "vault", to: a.host, text: a.name, fields: Object.keys(a.fields), by: o.by };
    const fail = (error: string) => {
      this.receipt(o.run_id, { ...base, ok: false, error });
      console.error(JSON.stringify({ at: "vault.fill", host: a.host, error }));
      return { ok: false, text: `${a.name} wasn't filled in: ${error}` };
    };
    const e = findEntry(this.sql, a.entry);
    if (!e) return fail("That vault entry isn't there any more.");
    const driver = this.channels.browser();
    if (!driver) return fail("This deployment has no browser.");
    const here = driver.where();
    if (!here.open) return fail("The browser closed before it could be filled in. Ask Atlas to do it again.");
    const host = hostOf(here.url);
    if (!fillsOn(e, host)) return fail(`The browser is on ${host}, and ${e.name} only fills on ${e.sites.join(", ")}.`);
    if (here.url !== a.url) return fail(`The browser moved on to ${here.url} since you were asked, so nothing was filled in.`);
    const values: Array<{ ref: string; value: string }> = [];
    for (const [field, ref] of Object.entries(a.fields)) {
      const value = await valueOf(e, field);
      if (!value) return fail(`${e.name} has no ${(FIELDS[e.kind][field] ?? field).toLowerCase()}.`);
      values.push({ ref, value });
    }
    try {
      if (a.press) {
        const el = await driver.find(a.press.ref);
        if (!el || el.text !== a.press.text) return fail("The page changed since you were asked, so nothing was filled in.");
      }
      const page = await driver.fill(values, a.press?.ref);
      const hidden = hiddenValues(this.sql);
      const now = scrub(page.title || hostOf(page.url), hidden);
      touchEntry(this.sql, e.id, (x) => ({
        ...x,
        uses: x.uses + 1,
        last_used: Date.now(),
        allowed: o.by === "approved" && x.kind !== "card" ? [...new Set([...x.allowed, siteFor(x, host)])] : x.allowed,
      }));
      this.receipt(o.run_id, { ...base, ok: true, ...(a.press ? { pressed: a.press.text } : {}), answer: `Now on ${now}` });
      const n = values.length;
      return {
        ok: true,
        text: `Filled ${n} ${n === 1 ? "field" : "fields"} from ${e.name} on ${host}${a.press ? ` and pressed "${a.press.text}"` : ""}. The page now says: ${now}.`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A mail out (§16.2). Nothing with one of the owner's secrets in it
   * leaves; the receipt names who it went to, as whom, and links to the
   * sent mail, and keeps the person and thread so replies and "last in
   * touch" find it.
   */
  async #mail(a: Extract<Action, { kind: "email" }>, o: { run_id: string | null; by: string }): Promise<{ ok: boolean; text: string }> {
    const base = {
      channel: "email",
      as: a.as,
      from: a.from,
      to: [...a.to, ...(a.cc ?? [])].join(", "),
      text: a.subject,
      by: o.by,
      ...(a.person ? { person: a.person } : {}),
    };
    if ([a.subject, a.text, ...a.to, ...(a.cc ?? [])].some((x) => scrub(x, this.secrets()) !== x)) {
      const text = `The mail to ${base.to} wasn't sent: it held one of your secrets.`;
      this.receipt(o.run_id, { ...base, text: scrub(a.subject, this.secrets()), ok: false, error: text, checks: { secrets: "failed" } });
      return { ok: false, text };
    }
    if (!this.channels.mail) {
      const text = "Mail can't be sent from here.";
      this.receipt(o.run_id, { ...base, ok: false, error: text });
      return { ok: false, text };
    }
    const out = await this.channels.mail(a).catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
      via: a.via,
    }));
    if (!out.ok) {
      this.receipt(o.run_id, { ...base, via: out.via, ok: false, error: out.error, checks: { secrets: "passed", ok: o.by } });
      console.error(JSON.stringify({ at: "mail.send", via: out.via, to: base.to, error: out.error }));
      return { ok: false, text: `The mail to ${base.to} didn't go: ${out.error}` };
    }
    this.receipt(o.run_id, {
      ...base,
      via: out.via,
      ok: true,
      ...(out.thread ? { thread: out.thread } : {}),
      ...(out.link ? { link: out.link } : {}),
      ...(out.message_id ? { message_id: out.message_id } : {}),
      checks: { secrets: "passed", ok: o.by },
    });
    return {
      ok: true,
      text: `Sent "${a.subject}" to ${base.to}${a.as === "atlas" ? ` from ${a.from}` : ""}.${out.link ? ` ${out.link}` : ""}`,
    };
  }

  /** A delivery receipt in the log (§4.2), shown in History. */
  private receipt(runId: string | null, body: Record<string, unknown>): LogRow {
    const row = append(this.sql, { actor: "atlas", kind: "delivery", run_id: runId, body });
    this.channels.broadcast([row]);
    return row;
  }
}

export type LookWhat = "search" | "fetch" | "browse" | "type" | "geocode" | "reverse" | "route" | "nearby" | "weather";

const WHERE: Record<LookWhat, string> = {
  search: "a web search",
  fetch: "a web address",
  browse: "a web address",
  type: "a web page",
  geocode: "a map search",
  reverse: "a map search",
  route: "a route",
  nearby: "a map search",
  weather: "a weather look",
};

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
