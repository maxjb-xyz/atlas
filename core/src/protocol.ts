// What the app and the person agent say to each other over the one socket.
// Voice uses the same socket with the Agents SDK voice protocol; every Atlas
// message type starts with "atlas." so the two never collide.

import { z } from "zod";
import type { LogRow } from "./store/log";
import type { AgendaItem } from "./store/agenda";
import { BrainChoice, Settings, SettingsPatch } from "./store/settings";
import { RECORD_TYPES } from "./store/records";
import { StageView, type StagePage } from "./stage";
import type { DiscordCopy } from "./discord";

export type { LogRow, AgendaItem };
export type { StagePage };

export interface RecordView {
  id: string;
  type: string;
  name: string;
  fact: string;
  details: Record<string, unknown>;
  areas: string[];
  learned_at: number;
  updated_at: number;
  confidence: number;
  /** Where it came from: the message it was learned from, when there is one. */
  source: { via: string; text?: string; at?: number; surface?: string | null };
  corrections: number;
  /** The value before the latest correction. */
  was: { name: string; fact: string; at: number } | null;
}

export type HistoryFilter = "everything" | "actions" | "conversations" | "jobs";

export interface HistoryStats {
  actions: number;
  conversations: number;
  jobs: number;
  tokens: number;
  /** Activity in each hour since local midnight. */
  per_hour: number[];
}

export interface CalendarEventView {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
}

export interface InboxItem {
  /** The log row it comes from. */
  id: string;
  kind: "review" | "failed";
  title: string;
  text: string;
  at: number;
  areas: string[];
  run_id: string | null;
}

/** An area as the app shows it, in Library → Areas and on chips (§6, §21.3). */
export interface AreaView {
  id: string;
  name: string;
  about: string;
  state: "active" | "dormant" | "archived";
  color: number;
  settings: { tone: string };
  messages: number;
  records: number;
  last_seen: number | null;
}

/** A helper's job as the app shows it (§21.4). */
export interface JobView {
  id: string;
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  /** What the helper is doing right now, such as "Thinking back." */
  status: string | null;
  steps: number;
  started_at: number;
  /** What the helper was asked, and what it handed back once done. */
  brief: string;
  result: string | null;
  run_id: string | null;
}

// --- app -> agent ----------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  /** Sent on connect. `tz` is the browser's zone, used until the owner sets one. */
  z.object({ type: z.literal("atlas.hello"), tz: z.string().max(64).optional() }),
  /** The owner says something in text. `client_id` lets the app match its optimistic bubble. */
  z.object({ type: z.literal("atlas.say"), text: z.string().min(1).max(20_000), client_id: z.string().max(64) }),
  /** Undo from a receipt. */
  z.object({ type: z.literal("atlas.undo"), log_id: z.string().max(64) }),
  /** Older thread rows, for scrolling back. */
  z.object({ type: z.literal("atlas.more"), before_seq: z.number().int() }),
  z.object({ type: z.literal("atlas.settings.update"), patch: SettingsPatch }),
  /** Set or clear (null) a secret. */
  z.object({
    type: z.literal("atlas.secret.set"),
    secret: z.discriminatedUnion("name", [
      z.object({ name: z.literal("elevenlabs_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({
        name: z.literal("icloud"),
        value: z.object({ username: z.string().min(3).max(200), app_password: z.string().min(4).max(64) }).nullable(),
      }),
      z.object({ name: z.literal("discord_bot_token"), value: z.string().trim().min(20).max(200).nullable() }),
    ]),
  }),
  /** Whether this device has Atlas in view, sent on connect and whenever it changes, so a message goes to one channel (§14). */
  z.object({ type: z.literal("atlas.presence"), device: z.string().min(1).max(64), visible: z.boolean() }),
  /** This device takes push notifications: its subscription, from PushSubscription.toJSON(). */
  z.object({
    type: z.literal("atlas.push.subscribe"),
    device: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    origin: z.string().url().max(200),
    subscription: z.object({
      endpoint: z.string().url().startsWith("https://").max(2_000),
      keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
    }),
  }),
  /** Stop sending notifications to a device. */
  z.object({ type: z.literal("atlas.push.remove"), device: z.string().min(1).max(64) }),
  /** The owner sends a message to a Discord channel from Settings, to check the way out. The result comes back as a test result. */
  z.object({
    type: z.literal("atlas.discord.send"),
    ref: z.string().max(64),
    channel_id: z.string().min(1).max(32),
    text: z.string().min(1).max(2_000),
  }),
  /** "Sign in with ChatGPT": start, then paste the address the browser landed on. */
  z.object({ type: z.literal("atlas.chatgpt.start") }),
  z.object({ type: z.literal("atlas.chatgpt.finish"), url: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("atlas.chatgpt.cancel") }),
  z.object({ type: z.literal("atlas.chatgpt.signout") }),
  /** Focus on one area, or null for all (the scope switcher, §21.3). */
  z.object({ type: z.literal("atlas.scope.set"), area: z.string().max(64).nullable() }),
  z.object({ type: z.literal("atlas.area.create"), name: z.string().min(1).max(60), about: z.string().max(500).optional() }),
  z.object({
    type: z.literal("atlas.area.update"),
    id: z.string().max(64),
    name: z.string().min(1).max(60).optional(),
    about: z.string().max(500).optional(),
    state: z.enum(["active", "dormant", "archived"]).optional(),
    settings: z.object({ tone: z.string().max(300).optional() }).optional(),
  }),
  z.object({ type: z.literal("atlas.area.merge"), from: z.string().max(64), into: z.string().max(64) }),
  /** Move an item to other areas by tapping its chip (§6.3): a message (`log:<id>`) or a record (`rec:<id>`). */
  z.object({
    type: z.literal("atlas.areas.set"),
    ref: z.string().regex(/^(log|rec):[\w-]+$/),
    areas: z.array(z.string().max(64)).max(10),
  }),
  /** Setup (§22): mark a step done, skipped, or open again. */
  z.object({
    type: z.literal("atlas.setup.step"),
    step: z.enum(["passkey", "meet", "brain", "connect", "look"]),
    state: z.enum(["done", "skipped", "open"]),
  }),
  /** Setup step 5: Atlas reads the calendar and proposes areas, people and things worth knowing. */
  z.object({ type: z.literal("atlas.setup.look") }),
  /** Save the people the owner kept from Atlas's first look. */
  z.object({
    type: z.literal("atlas.setup.people"),
    people: z.array(z.object({ name: z.string().min(1).max(80), why: z.string().max(300) })).max(20),
  }),
  /** The voices the owner can pick from, with samples. */
  z.object({ type: z.literal("atlas.voices.list") }),
  /** Remove a passkey (Settings → Devices). It also ends the sessions it opened. */
  z.object({ type: z.literal("atlas.passkey.remove"), id: z.string().max(512) }),
  /** Sign out everywhere. */
  z.object({ type: z.literal("atlas.sessions.end") }),
  /** Library: records, by type, area or text. `ref` is echoed back. */
  z.object({
    type: z.literal("atlas.records.list"),
    ref: z.string().max(64),
    record_type: z.enum(["all", ...RECORD_TYPES]).optional(),
    area: z.string().max(64).nullable().optional(),
    text: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  /** Correct a record by hand (Library's Correct link): the old value stays in history. */
  z.object({
    type: z.literal("atlas.record.correct"),
    id: z.string().max(64),
    name: z.string().min(1).max(120).optional(),
    fact: z.string().max(600).optional(),
  }),
  z.object({ type: z.literal("atlas.record.forget"), id: z.string().max(64) }),
  /** History: the log, newest first. */
  z.object({
    type: z.literal("atlas.history"),
    filter: z.enum(["everything", "actions", "conversations", "jobs"]),
    before_seq: z.number().int().optional(),
    area: z.string().max(64).nullable().optional(),
    /** Local midnight, for today's totals. */
    day_start: z.number().int(),
  }),
  /** Everything one run did, for a History row's receipt. */
  z.object({ type: z.literal("atlas.run.detail"), run_id: z.string().max(64) }),
  /** Calendar events for Week and Agenda, as local dates or times. `ref` is echoed back. */
  z.object({ type: z.literal("atlas.calendar"), ref: z.string().max(64), start: z.string().max(40), end: z.string().max(40) }),
  z.object({ type: z.literal("atlas.inbox") }),
  z.object({ type: z.literal("atlas.inbox.done"), id: z.string().max(64) }),
  /** The live page behind an area or person view on the stage, or in Library (§21.6). `ref` is echoed back. */
  z.object({ type: z.literal("atlas.stage"), ref: z.string().max(200), view: StageView }),
  /** Stop a helper's job (Stop on the Jobs tab). */
  z.object({ type: z.literal("atlas.job.stop"), id: z.string().max(64) }),
  /** Live checks for Settings (§22: every check is a live test). */
  z.object({
    type: z.literal("atlas.test"),
    what: z.enum(["calendar", "brain", "voice", "character", "sample", "push", "discord"]),
    /** For "push": the device to send the test notification to. */
    device: z.string().max(64).optional(),
    /** Echoed back on the result, so the app knows which button it answers. */
    ref: z.string().max(64).optional(),
    /** A brain to test: a spot in a saved chain, or an unsaved choice. */
    role: z.enum(["main", "voice"]).optional(),
    index: z.number().int().optional(),
    choice: BrainChoice.optional(),
    /** For "sample": an unsaved character to hear before saving it. */
    character: Settings.shape.character.optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- agent -> app ----------------------------------------------------------

/** Settings as the app sees them: values, plus whether each secret is set (never the secret). */
export interface SettingsView {
  settings: import("./store/settings").Settings;
  secrets: {
    elevenlabs_api_key: boolean;
    /**
     * `refused` says when and why iCloud last refused the sign-in, how many times in a row, and when Atlas tries
     * again by itself; `note` says all that in a sentence. Meanwhile Atlas answers from its copy of the calendar.
     */
    icloud: {
      username: string;
      refused: { at: number; message: string; tries: number; next_try: number; note: string } | null;
    } | null;
    /** The Discord bot: set or not, what it could see at its last check, and the link that invites it to a server. */
    discord: { copy: DiscordCopy | null; invite: string | null } | null;
  };
  chatgpt: ChatGPTView;
  /** Provider health, by "provider:model". */
  health: Record<string, { ok: boolean; reason?: string; checked_at: number }>;
  /** The owner's passkeys, without their keys (Settings → Devices). */
  passkeys: Array<{ id: string; name: string; created_at: number; last_used: number | null }>;
  /** Push notifications (Settings → Notifications): this deployment's public key, and the devices that take them. */
  push: { public_key: string | null; devices: Array<{ id: string; name: string; added_at: number; last_seen: number }> };
  setup: { done: string[]; skipped: string[]; finished: boolean };
}

export type ChatGPTView =
  | { state: "signed_out" }
  /** Waiting for the owner to sign in at `authorize_url` and paste back where they landed. */
  | { state: "pending"; authorize_url: string; expires_at: number; error?: string }
  | { state: "signed_in"; email: string | null; models: string[] }
  | { state: "error"; message: string };

export type RunState = "running" | "replied" | "deferred" | "failed";

export type ServerMessage =
  | {
      type: "atlas.snapshot";
      thread: LogRow[];
      agenda: AgendaItem[];
      view: SettingsView;
      /** Runs in progress, with what they've streamed so far, so a refresh mid-answer picks up where it was. */
      running: Array<{ run_id: string; surface: string; text?: string; status?: string | null }>;
      jobs: JobView[];
      areas: AreaView[];
      /** The area the owner is focused on, or null for all. */
      scope: string | null;
    }
  /** A new or older thread row. The saved truth: it replaces any streamed text for its run. */
  | { type: "atlas.rows"; rows: LogRow[]; older?: boolean; has_more?: boolean }
  /** Streamed reply text for a run in progress. A progress hint only (§4.1). */
  | { type: "atlas.delta"; run_id: string; text: string }
  /** What Atlas is doing right now in a run, such as "Checking your calendar". */
  | { type: "atlas.status"; run_id: string; text: string | null }
  | { type: "atlas.run"; run_id: string; state: RunState; surface: string; client_id?: string }
  | { type: "atlas.agenda"; agenda: AgendaItem[] }
  | { type: "atlas.areas"; areas: AreaView[]; scope: string | null }
  | { type: "atlas.records"; ref: string; records: RecordView[]; counts: Record<string, number> }
  /** Records changed (a correction, a forget, a save): pages showing records ask again. */
  | { type: "atlas.records.changed" }
  | { type: "atlas.history.rows"; filter: HistoryFilter; rows: LogRow[]; has_more: boolean; older: boolean; stats?: HistoryStats }
  | { type: "atlas.run.detail.result"; run_id: string; run: Record<string, unknown> | null; rows: LogRow[] }
  /** `stale` is set when iCloud couldn't be asked: the events are Atlas's copy from `as_of`, and `why` says why. */
  | { type: "atlas.calendar.events"; ref: string; events: CalendarEventView[]; error?: string; stale?: { as_of: number; why: string } }
  | { type: "atlas.inbox.items"; items: InboxItem[] }
  | { type: "atlas.stage.page"; ref: string; page: StagePage | null }
  | {
      type: "atlas.voices";
      voices: Array<{ id: string; name: string; preview_url: string | null; description: string }>;
      error?: string;
    }
  | {
      type: "atlas.setup.look.result";
      look: { areas: Array<{ name: string; about: string }>; people: Array<{ name: string; why: string }>; notes: string[] } | null;
      error?: string;
    }
  /** Helpers' jobs: running ones, and ones that ended in the last hour (§21.4). */
  | { type: "atlas.jobs"; jobs: JobView[] }
  | { type: "atlas.view"; view: SettingsView }
  | { type: "atlas.test.result"; what: string; ref?: string; ok: boolean; message: string; detail?: unknown }
  | { type: "atlas.error"; message: string }
  /** This socket's sign-in was ended; the app goes back to signing in. */
  | { type: "atlas.signed_out" };
