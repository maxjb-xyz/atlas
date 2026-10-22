// One way out (§4.4): every message from Atlas leaves through here. To the
// owner, it picks one channel (§14): the app when it's in view, a live call,
// or else a push to the device used last, held through quiet hours unless it
// can't wait. Every delivery beyond the thread leaves a receipt in the log.
// Approvals join the exit checks next; sharing rules and the public-query
// check in M3 and M5.

import { type PushSubscriptionJSON, sendPush, vapidKeys } from "./push";
import { type Action } from "./approvals";
import type { Sql } from "./store/db";
import { append, get as getRow, type LogRow, type Surface } from "./store/log";
import { readSettings, secretValues } from "./store/settings";
import { getState, setState } from "./store/state";
import { deleteRecord } from "./store/records";
import { quietUntil, shortLocal, zoneOf } from "./time";
import { callWebhook, webhooks, webhookView } from "./webhooks";

export const HIDDEN = "[hidden]";

/** Replaces any stored secret that appears in outgoing text. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(HIDDEN);
  return out;
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

/** "now" goes out at once; "normal" waits for quiet hours to end (§14). */
export type Urgency = "now" | "normal";

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
  /** For spoken replies: when the status line and the answer were ready. */
  timing?: Record<string, unknown>;
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
  hold(at: Date, note: Note): Promise<void>;
  fetch: typeof fetch;
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
        ...(d.timing ? { timing: d.timing as never } : {}),
      },
    });
    this.channels.broadcast([row]);
    // One channel (§14): heard in a call, or seen in an app in view, needs no push as well.
    if (channel !== "voice" && channel !== "api" && !this.channels.looking()) await this.notify(noteOf(row), d.urgency ?? "normal");
    return row;
  }

  /** Tells the owner, on one device, about something they haven't seen. `extra` goes to the service worker with it. */
  async notify(row: Note, urgency: Urgency, extra?: Record<string, unknown>): Promise<void> {
    const settings = readSettings(this.sql);
    if (!settings.notifications.push || !pushDevices(this.sql).length) return;
    const until = urgency === "now" ? null : quietUntil(new Date(), zoneOf(settings), settings.notifications.quiet);
    if (until) {
      await this.channels.hold(until, row);
      this.receipt(row.run_id, {
        of: [row.id],
        channel: "push",
        ok: true,
        held_until: until.getTime(),
        note: `Held for quiet hours, until ${shortLocal(until, zoneOf(settings))}.`,
      });
      return;
    }
    await this.push([row], urgency, { extra });
  }

  /** Notifications held through quiet hours: one push for all of them, unless the owner has opened Atlas since. */
  async release(rows: Note[]): Promise<void> {
    if (!rows.length) return;
    if (this.channels.looking()) {
      this.receipt(rows[0]!.run_id, { of: rows.map((r) => r.id), channel: "push", ok: true, note: "Not sent: you had Atlas open." });
      return;
    }
    await this.push(rows, "normal");
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
        this.receipt(first.run_id, { of: rows.map((r) => r.id), channel: "push", to: d.name, ok: true });
        return { ok: true };
      }
      error = out.gone ? `${out.error}. That device stopped taking notifications, so Atlas forgot it.` : (out.error ?? "It failed.");
      if (out.gone)
        setState(
          this.sql,
          "push_devices",
          pushDevices(this.sql).filter((x) => x.id !== d.id),
        );
      this.receipt(first.run_id, { of: rows.map((r) => r.id), channel: "push", to: d.name, ok: false, error });
      console.error(JSON.stringify({ at: "push", device: d.name, status: out.status, error }));
    }
    return { ok: false, error };
  }

  /**
   * Does what the owner's OK (or earned trust, or the owner's own button)
   * allowed. The exit checks run first; a webhook call leaves a delivery
   * receipt with what it answered. `by` says whose word it went out on.
   */
  async perform(
    a: Action,
    o: { run_id: string | null; by: "approved" | "trusted" | "owner" | "automation" },
  ): Promise<{ ok: boolean; text: string }> {
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

  /** A delivery receipt in the log (§4.2), shown in History. */
  private receipt(runId: string | null, body: Record<string, unknown>): LogRow {
    const row = append(this.sql, { actor: "atlas", kind: "delivery", run_id: runId, body });
    this.channels.broadcast([row]);
    return row;
  }
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
