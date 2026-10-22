// What the app and the person agent say to each other over the one socket.
// Voice uses the same socket with the Agents SDK voice protocol; every Atlas
// message type starts with "atlas." so the two never collide.

import type { SuggestionView } from "./suggestions";

/** A page as Library lists it (§21.7). */
export interface PageSummary {
  id: string;
  name: string;
  version: number;
  updated_at: number;
  made_by: "owner" | "atlas";
  /** The first words of its text. */
  preview: string;
  /** The kinds of view kept in it. */
  views: string[];
}
import { z } from "zod";
import type { LogRow } from "./store/log";
import type { AgendaItem } from "./store/agenda";
import { BrainChoice, Settings, SettingsPatch } from "./store/settings";
import { RECORD_TYPES } from "./store/records";
import { StageView, type AutomationView, type StagePage } from "./stage";
import { AutomationInput } from "./automations";

export type { LogRow, AgendaItem };
export type { StagePage, AutomationView };

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

/** One step of an approval card, as the owner sees it (§12.2). */
export interface ApprovalStep {
  kind: "webhook" | "delete" | "browser" | "vault" | "site" | "mcp" | "mcp_add";
  title: string;
  /** What it does, in a sentence. */
  detail: string;
  /** Where it goes, or what it touches. */
  where: string;
  /** Whether and how it can be undone. */
  undo: string;
  /** The text a webhook gets, which the owner can edit in the card. */
  message?: string;
}

/** An approval card: every step of the plan, why it needs the OK, and the checks it passed. */
export interface ApprovalView {
  id: string;
  title: string;
  steps: ApprovalStep[];
  /** What the owner said that led to it, when it came from a conversation. */
  asked: string | null;
  why: string;
  hold: boolean;
  expires_at: number;
  checks: Array<{ name: string; ok: boolean }>;
}

export interface InboxItem {
  /** The log row it comes from; for an approval, its id; for a question, its key. */
  id: string;
  kind: "review" | "failed" | "approval" | "question";
  title: string;
  text: string;
  at: number;
  areas: string[];
  run_id: string | null;
  approval?: ApprovalView;
  /** Atlas asking the owner something it can't decide alone, such as whether to stop asking for an action. */
  question?: { key: string; yes: string; no: string };
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
      z.object({ name: z.literal("tavily_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({ name: z.literal("brave_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({ name: z.literal("exa_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({ name: z.literal("mapbox_token"), value: z.string().min(20).max(400).nullable() }),
      z.object({
        name: z.literal("icloud"),
        value: z.object({ username: z.string().min(3).max(200), app_password: z.string().min(4).max(64) }).nullable(),
      }),
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
  /** The owner's answer to an approval card. `hold` is set when they held to confirm; `edits` change a step's message. */
  z.object({
    type: z.literal("atlas.approval.decide"),
    id: z.string().max(64),
    yes: z.boolean(),
    hold: z.boolean().optional(),
    edits: z
      .array(z.object({ index: z.number().int().min(0).max(20), message: z.string().max(4_000) }))
      .max(20)
      .optional(),
  }),
  /** Let Atlas do one outside action without asking, or ask again (earned trust, §12.2). */
  z.object({ type: z.literal("atlas.trust.set"), key: z.string().max(100), trusted: z.boolean() }),
  /** Add or change a webhook (Settings → Connections). On a change, an empty url keeps the address it had. */
  z.object({
    type: z.literal("atlas.webhook.save"),
    id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(60),
    url: z.string().max(2_000).optional(),
    method: z.enum(["POST", "GET"]),
    about: z.string().max(300),
  }),
  z.object({ type: z.literal("atlas.webhook.remove"), id: z.string().max(64) }),
  /** Add or change a vault entry (§15). Empty values on a change keep what was there; `totp: null` removes the seed. */
  z.object({
    type: z.literal("atlas.vault.save"),
    id: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(60),
    kind: z.enum(["login", "card", "key"]),
    sites: z.array(z.string().max(200)).min(1).max(10),
    values: z.record(z.string().max(40), z.string().max(4_000)),
    totp: z.string().max(200).nullable().optional(),
  }),
  z.object({ type: z.literal("atlas.vault.remove"), id: z.string().max(64) }),
  /** Take back the owner's yes for one site, so the next use there asks again. */
  z.object({ type: z.literal("atlas.vault.revoke"), id: z.string().max(64), site: z.string().max(200) }),
  /** The Automations page: every automation. */
  z.object({ type: z.literal("atlas.automations") }),
  /** Make or change an automation in the form. The owner's own start on (§13.4). */
  z.object({ type: z.literal("atlas.automation.save"), id: z.string().max(64).optional(), automation: AutomationInput }),
  z.object({ type: z.literal("atlas.automation.set"), id: z.string().max(64), on: z.boolean() }),
  /** A suggestion at the top of Automations: made into one, or set aside. Neither is suggested again. */
  z.object({ type: z.literal("atlas.suggestion.set"), id: z.string().max(64), state: z.enum(["dismissed", "made"]) }),
  /** Run now (the Run button), or as a test that sends nothing. */
  z.object({
    type: z.literal("atlas.automation.run"),
    id: z.string().max(64),
    test: z.boolean().optional(),
    inputs: z.record(z.string().max(30), z.string().max(200)).optional(),
  }),
  z.object({ type: z.literal("atlas.automation.delete"), id: z.string().max(64) }),
  /** Cancel a reminder or promise from Agenda. */
  z.object({ type: z.literal("atlas.agenda.cancel"), id: z.string().max(64) }),
  /** Stop sending notifications to a device. */
  z.object({ type: z.literal("atlas.push.remove"), device: z.string().min(1).max(64) }),
  /** Focus for a while (§14), or end it with 0 minutes. */
  z.object({ type: z.literal("atlas.focus"), minutes: z.number().int().min(0).max(720), about: z.string().max(80).optional() }),
  /** Agenda's Done or Drop on an errand. */
  z.object({ type: z.literal("atlas.errand.done"), id: z.string().max(64), done: z.boolean() }),
  /** Settings → Devices → Set up OwnTracks: makes OwnTracks' own user and password (replacing any before) and its setup link. */
  z.object({ type: z.literal("atlas.location.setup") }),
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
    step: z.enum(["passkey", "meet", "brain", "connect", "look", "routines"]),
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
  /** The owner's buttons on the browser's view (§9.1): take it over, hand it back to Atlas, or close it. */
  z.object({ type: z.literal("atlas.browser"), action: z.enum(["take", "give", "close"]) }),
  /** Library's pages (§21.7). */
  z.object({ type: z.literal("atlas.pages") }),
  /** The Skills page (§9.3): every skill; save one from its SKILL.md (an edit or an import); archive or bring back; restore a version. */
  z.object({ type: z.literal("atlas.skills") }),
  z.object({ type: z.literal("atlas.skill.save"), md: z.string().min(20).max(40_000) }),
  z.object({ type: z.literal("atlas.skill.state"), id: z.string().max(64), state: z.enum(["active", "archived"]) }),
  z.object({ type: z.literal("atlas.skill.restore"), id: z.string().max(64), n: z.number().int().min(1) }),
  /** The workspace (§9.1): keep a file from it in Library, or take back a site it may reach. */
  z.object({ type: z.literal("atlas.workspace.keep"), path: z.string().min(1).max(500) }),
  z.object({ type: z.literal("atlas.workspace.site.remove"), site: z.string().min(1).max(200) }),
  /** Stop the workspace's container, so the next command starts it fresh (its files and setup are kept). */
  z.object({ type: z.literal("atlas.workspace.restart") }),
  /**
   * Connected MCP servers (§9.2): the list, adding one by its address (with a
   * token for servers that take one instead of a sign-in), and removing one.
   */
  z.object({ type: z.literal("atlas.mcp") }),
  z.object({
    type: z.literal("atlas.mcp.add"),
    name: z.string().trim().min(1).max(60),
    url: z.string().url().max(500),
    token: z.string().max(4_000).optional(),
  }),
  z.object({ type: z.literal("atlas.mcp.remove"), id: z.string().max(64) }),
  /** An MCP App on the stage (§21.6): its page, and what the page asks of its server. `req` is echoed back. */
  z.object({ type: z.literal("atlas.mcp.app"), req: z.string().max(64), call: z.string().max(64) }),
  z.object({
    type: z.literal("atlas.mcp.app.call"),
    req: z.string().max(64),
    call: z.string().max(64),
    name: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("atlas.mcp.app.read"), req: z.string().max(64), call: z.string().max(64), uri: z.string().min(1).max(2_000) }),
  /** Stop one of the owner's text runs, under way or waiting in line. */
  z.object({ type: z.literal("atlas.run.stop"), run_id: z.string().max(64) }),
  /** Library's files (§21.7), and deleting one. */
  z.object({ type: z.literal("atlas.files") }),
  z.object({ type: z.literal("atlas.file.delete"), id: z.string().max(64) }),
  /** Keep: saves a view on the stage as a new page. */
  z.object({ type: z.literal("atlas.page.keep"), view: StageView, name: z.string().trim().min(1).max(80) }),
  /** The owner's edit: a new version with this body. */
  z.object({
    type: z.literal("atlas.page.save"),
    id: z.string().max(64),
    name: z.string().trim().min(1).max(80),
    body: z.string().max(60_000),
    note: z.string().max(300).optional(),
  }),
  /** A new version that brings an older one back. */
  z.object({ type: z.literal("atlas.page.restore"), id: z.string().max(64), version: z.number().int().min(1) }),
  z.object({ type: z.literal("atlas.page.delete"), id: z.string().max(64) }),
  /** Stop a helper's job (Stop on the Jobs tab). */
  z.object({ type: z.literal("atlas.job.stop"), id: z.string().max(64) }),
  /** Live checks for Settings (§22: every check is a live test). */
  z.object({
    type: z.literal("atlas.test"),
    what: z.enum(["calendar", "brain", "voice", "character", "sample", "push", "webhook", "search", "maps"]),
    /** For "push": the device to send the test notification to. */
    device: z.string().max(64).optional(),
    /** For "webhook": which one to call. */
    id: z.string().max(64).optional(),
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

/** A skill as the Skills page shows it (§9.3): what it says, how it's used, its check, and every version. */
export interface SkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  check: string;
  made_by: "owner" | "atlas";
  state: "active" | "archived";
  version: number;
  uses: number;
  last_used: number | null;
  checked: { at: number; ok: boolean; output: string } | null;
  updated_at: number;
  versions: Array<{ n: number; at: number; by: "owner" | "atlas"; note: string }>;
  /** The whole thing as a SKILL.md, to edit or take elsewhere. */
  md: string;
}

/** A connected MCP server as Settings shows it (§9.2): never its token. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  state: string;
  error: string | null;
  /** Where the owner signs in, while the server waits for it. */
  auth_url: string | null;
  tools: Array<{ name: string; title: string | null; description: string; reads: boolean; page: boolean }>;
}

/** An MCP App's page and the call it shows, for the frame on the stage (§21.6). */
export interface McpAppPage {
  server: string;
  html: string;
  /** The Content-Security-Policy its page runs under: nothing outside it unless its server declared the domain. */
  csp: string;
  border: boolean;
  tool: Record<string, unknown>;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** Settings as the app sees them: values, plus whether each secret is set (never the secret). */
export interface SettingsView {
  settings: import("./store/settings").Settings;
  secrets: {
    elevenlabs_api_key: boolean;
    tavily_api_key: boolean;
    brave_api_key: boolean;
    exa_api_key: boolean;
    mapbox_token: boolean;
    /**
     * `refused` says when and why iCloud last refused the sign-in, how many times in a row, and when Atlas tries
     * again by itself; `note` says all that in a sentence. Meanwhile Atlas answers from its copy of the calendar.
     */
    icloud: {
      username: string;
      refused: { at: number; message: string; tries: number; next_try: number; note: string } | null;
    } | null;
  };
  chatgpt: ChatGPTView;
  /** Provider health, by "provider:model". */
  health: Record<string, { ok: boolean; reason?: string; checked_at: number }>;
  /** The owner's passkeys, without their keys (Settings → Devices). */
  passkeys: Array<{ id: string; name: string; created_at: number; last_used: number | null }>;
  /** The vault's entries, without their values (Settings → Vault). */
  vault: import("./vault-fields").VaultView[];
  /** The owner's webhooks, without their addresses (Settings → Connections). */
  webhooks: import("./webhooks").WebhookView[];
  /** When Atlas asks (Settings → Permissions): the table by kind, and the outside actions it may do without asking. */
  permissions: {
    kinds: typeof import("./approvals").ASKS;
    trusted: Array<{ key: string; name: string; since: number }>;
  };
  /** Push notifications (Settings → Notifications): this deployment's public key, and the devices that take them. */
  push: {
    public_key: string | null;
    devices: Array<{ id: string; name: string; added_at: number; last_seen: number }>;
    /** Pushes today for things that could wait, against the budget. */
    today: number;
  };
  /** Focus in force, if any (§14). */
  focus: { until: number; about: string } | null;
  setup: { done: string[]; skipped: string[]; finished: boolean };
  /** Location (Settings → Devices, §10.1): whether OwnTracks is set up, the last fix and place, and the last refused post. */
  location: LocationView;
}

export interface LocationView {
  set_up: boolean;
  made_at: number | null;
  fix: { at: number; acc: number; batt?: number; charging?: boolean; conn?: string } | null;
  place: { name: string; since: number } | null;
  /** The nearest saved place, when not at one. */
  near: { name: string; m: number } | null;
  refused: { at: number; n: number } | null;
  /** Saved places with a pin, which the phone has as regions. */
  pins: number;
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
  | { type: "atlas.automations"; automations: AutomationView[]; suggestions: SuggestionView[] }
  | { type: "atlas.pages"; pages: PageSummary[] }
  | { type: "atlas.files"; files: import("./stage").FileRow[] }
  | { type: "atlas.skills"; skills: SkillView[] }
  | { type: "atlas.mcp.servers"; servers: McpServerView[] }
  | { type: "atlas.mcp.app.result"; req: string; page?: McpAppPage; error?: string }
  /** What the page's own tool call or read answered: MCP's result as-is, or why it didn't happen. */
  | { type: "atlas.mcp.app.answer"; req: string; result?: Record<string, unknown>; error?: string }
  /** What a command in the workspace prints, as it prints it (a progress hint; the tool's result is the truth). */
  | { type: "atlas.workspace.out"; run_id: string; text: string }
  /** Keep worked: the new page, so the view can say where it went. */
  | { type: "atlas.page.kept"; id: string; name: string }
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
  /** The situation changed (a sense event, a refresh): views showing it, and Now, ask again. */
  | { type: "atlas.situation" }
  /** OwnTracks' setup, shown once: where it posts, its user and password, and the link that fills them in. */
  | { type: "atlas.location.setup"; url: string; user: string; password: string; link: string }
  | { type: "atlas.test.result"; what: string; ref?: string; ok: boolean; message: string; detail?: unknown }
  | { type: "atlas.error"; message: string }
  /** This socket's sign-in was ended; the app goes back to signing in. */
  | { type: "atlas.signed_out" };
