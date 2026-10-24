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
import { FaceInput } from "./face-shape";
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
  /** For a person (§7.1): how to reach them, each with where it came from, and how much the owner trusts them. */
  channels?: Array<{ kind: string; value: string; via: string }>;
  trust?: string;
  /** Whether faces may share it, from its areas (§7.2). */
  shared: boolean;
}

export type HistoryFilter = "everything" | "actions" | "conversations" | "jobs" | "faces";

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
  kind: "webhook" | "delete" | "browser" | "vault" | "site" | "mcp" | "mcp_add" | "node" | "email" | "face_reply" | "pull_request";
  title: string;
  /** What it does, in a sentence. */
  detail: string;
  /** Where it goes, or what it touches. */
  where: string;
  /** Whether and how it can be undone. */
  undo: string;
  /** The text a webhook gets, or a mail's words, which the owner can edit in the card. */
  message?: string;
  /** A mail's envelope: who it's from (fixed), and who it's to and its subject (editable). */
  mail?: { from: string; to: string; cc?: string; subject: string };
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
  kind: "review" | "failed" | "approval" | "question" | "face";
  title: string;
  text: string;
  at: number;
  areas: string[];
  run_id: string | null;
  approval?: ApprovalView;
  /** Atlas asking the owner something it can't decide alone, such as whether to stop asking for an action. */
  question?: { key: string; yes: string; no: string };
  /** A coding job's question for the owner (§8.2): the answer goes back to its agent. */
  job?: { id: string; title: string; question: string; options: string[]; why?: string; content?: string };
  /** What a face handed the owner (§7.2): who it's from, the conversation, and whether it can be answered from here. */
  face?: {
    name: string;
    from: string;
    urgent: boolean;
    reach: string[];
    details: Record<string, string>;
    conversation: Array<{ who: "them" | "face" | "you"; text: string }>;
    can_answer: boolean;
  };
}

/** An area as the app shows it, in Library → Areas and on chips (§6, §21.3). */
export interface AreaView {
  id: string;
  name: string;
  about: string;
  state: "active" | "dormant" | "archived";
  color: number;
  settings: { tone: string; shared_with: string[] };
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
  /** The named brain it runs on (§18), when it isn't the main one. */
  brain?: string;
  /** A coding job (§8.2, §21.4): its steps, the agent's stream, what Atlas answered for the owner, and what waits on them. */
  coding?: CodingView;
  /** A job Atlas owns (§8.3): its plan, what it has done and said, what waits on the owner, and what it has used. */
  goal?: GoalView;
}

export interface GoalView {
  phase: "working" | "waiting" | "paused" | "done" | "failed" | "cancelled";
  folder: string;
  plan: Array<{
    id: string;
    title: string;
    kind: "work" | "research" | "checkpoint";
    state: "todo" | "doing" | "done" | "failed" | "skipped";
    brain?: string;
  }>;
  log: Array<{ at: number; who: "atlas" | "owner" | "step"; text: string }>;
  question: { text: string; options: string[]; content?: string } | null;
  /** Looks and steps used, and steps by named brain (§18). */
  spent: { looks: number; steps: number; by: Record<string, number> };
  budget: { looks: number; steps: number };
  /** Files it kept in Library. */
  files: string[];
}

export interface CodingView {
  phase: "preparing" | "working" | "deciding" | "waiting" | "publishing" | "done" | "failed" | "cancelled";
  agent: string;
  repo: string;
  branch: string;
  base: string;
  branch_link: string | null;
  steps: Array<{ name: string; state: "done" | "now" | "todo" }>;
  /** The agent's messages and commands, Atlas's notes and replies, and the owner's words, oldest first. */
  log: Array<{ at: number; who: "agent" | "atlas" | "owner" | "tool" | "note" | "plan"; text: string; status?: string; out?: string }>;
  /** Questions Atlas answered for the owner, each with where the answer came from ("you" for the owner's own). */
  answers: Array<{ q: string; a: string; source: string; at: number }>;
  question: { text: string; options: string[]; why?: string; site?: string; approval?: string } | null;
  /** Dollars spent so far, when the agent says, and the cap. */
  cost: number | null;
  cap: number | null;
  pr: { number: number; link: string; title: string } | null;
  error: string | null;
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
  /** A provider's live list of models, for the model picker (§11.4: from the provider's catalog, not from code). */
  z.object({ type: z.literal("atlas.brain.models"), provider: z.enum(["chatgpt", "workers-ai", "anthropic"]) }),
  /** Set or clear (null) a secret. */
  z.object({
    type: z.literal("atlas.secret.set"),
    secret: z.discriminatedUnion("name", [
      z.object({ name: z.literal("elevenlabs_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({ name: z.literal("anthropic_api_key"), value: z.string().min(20).max(300).nullable() }),
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
      .array(
        z.object({
          index: z.number().int().min(0).max(20),
          message: z.string().max(20_000),
          /** A mail's subject and who it's to, as the owner changed them in the card. */
          subject: z.string().max(300).optional(),
          to: z.string().max(1_000).optional(),
        }),
      )
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
  /** The pairing a code names (§16.3), so the owner sees what's asking before saying yes. */
  z.object({ type: z.literal("atlas.node.pairing"), code: z.string().min(4).max(20) }),
  /** The owner's yes or no to pairing a device. */
  z.object({ type: z.literal("atlas.node.pair"), code: z.string().min(4).max(20), yes: z.boolean() }),
  /** A device's capability turned on or off. */
  z.object({ type: z.literal("atlas.node.allow"), id: z.string().max(64), capability: z.string().max(40), on: z.boolean() }),
  /** Unpairs a device at once. */
  z.object({ type: z.literal("atlas.node.remove"), id: z.string().max(64) }),
  /** Agenda's Close on an open loop (§10.4). */
  z.object({ type: z.literal("atlas.loop.close"), id: z.string().max(64) }),
  /** Agenda's Done or Drop on a task (§5.1). */
  z.object({ type: z.literal("atlas.task.done"), id: z.string().max(64), done: z.boolean() }),
  /** Settings → Extensions (§17): install a bundled one or a draft, remove one, or turn one on or off. */
  z.object({ type: z.literal("atlas.ext.install"), id: z.string().max(40) }),
  z.object({ type: z.literal("atlas.ext.remove"), id: z.string().max(40) }),
  z.object({ type: z.literal("atlas.ext.state"), id: z.string().max(40), on: z.boolean() }),
  /** An extension's secrets (an empty or null value removes one) and settings, as its manifest names them. */
  z.object({
    type: z.literal("atlas.ext.secrets"),
    id: z.string().max(40),
    secrets: z.record(z.string().max(40), z.string().max(4_000).nullable()),
  }),
  z.object({ type: z.literal("atlas.ext.settings"), id: z.string().max(40), settings: z.record(z.string().max(40), z.string().max(400)) }),
  /** Run its setup (shown once), its live test, or start its sign-in. */
  z.object({ type: z.literal("atlas.ext.setup"), id: z.string().max(40) }),
  z.object({ type: z.literal("atlas.ext.test"), id: z.string().max(40) }),
  z.object({ type: z.literal("atlas.ext.signin"), id: z.string().max(40) }),
  /** Atlas's own address (§16.2): set it up on a domain with a token for the domain's account, take it down, or test it. */
  z.object({
    type: z.literal("atlas.mail.setup"),
    domain: z.string().trim().min(3).max(200),
    token: z.string().trim().max(200).optional(),
    sending: z.string().max(40),
  }),
  z.object({ type: z.literal("atlas.mail.remove") }),
  /** Faces (§7.2): make or change one, remove it, talk to it as a stranger, or answer what one handed you. */
  z.object({ type: z.literal("atlas.face.save"), face: FaceInput }),
  z.object({ type: z.literal("atlas.face.remove"), id: z.string().max(40) }),
  z.object({ type: z.literal("atlas.face.test"), id: z.string().max(40), conv: z.string().max(40), text: z.string().min(1).max(4_000) }),
  z.object({ type: z.literal("atlas.face.answer"), id: z.string().max(64), text: z.string().min(1).max(4_000) }),
  /** A chat channel (§16.1): a code for the owner to send from their own account, or forgetting who they are there. */
  z.object({ type: z.literal("atlas.channel.code"), ext: z.string().max(40) }),
  z.object({ type: z.literal("atlas.channel.unlink"), ext: z.string().max(40) }),
  /** Members (§7.1): invite one (again, for one who hasn't joined), change a role, remove one. */
  z.object({
    type: z.literal("atlas.member.invite"),
    name: z.string().trim().min(1).max(60),
    role: z.enum(["admin", "member"]),
    id: z.string().max(40).optional(),
  }),
  z.object({ type: z.literal("atlas.member.role"), id: z.string().max(40), role: z.enum(["admin", "member"]) }),
  z.object({ type: z.literal("atlas.member.remove"), id: z.string().max(40) }),
  /** Shares an area with a member, or stops (§6, §7.1). */
  z.object({ type: z.literal("atlas.area.share"), area: z.string().max(64), member: z.string().max(40), shared: z.boolean() }),
  /** The areas shared with this person, with what's in them. */
  z.object({ type: z.literal("atlas.shared") }),
  /** Whether faces may share a record from its areas (§7.2). */
  z.object({ type: z.literal("atlas.record.share"), id: z.string().max(64), shared: z.boolean() }),
  z.object({ type: z.literal("atlas.mail.test") }),
  /** Library → People → Import: from an extension that provides contacts, or a vCard file's text. */
  z.object({ type: z.literal("atlas.contacts.import"), from: z.string().max(40).optional(), vcards: z.string().max(5_000_000).optional() }),
  /** Settings → Connections → Senses: a webhook source with its own address and key, or removing one. */
  z.object({ type: z.literal("atlas.sense.hook.add"), name: z.string().min(1).max(60) }),
  z.object({ type: z.literal("atlas.sense.hook.remove"), id: z.string().max(64) }),
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
    filter: z.enum(["everything", "actions", "conversations", "jobs", "faces"]),
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
  /** The owner's words for a coding job (§8.2): the answer to its question, or Steer while it works. */
  z.object({ type: z.literal("atlas.job.say"), id: z.string().max(64), text: z.string().min(1).max(4_000) }),
  /**
   * Phone calls (§16.1): the calls extension's numbers, using one, giving it back, numbers to buy and buying
   * one, and a test call to the owner. The answer is one atlas.calls.
   */
  z.object({ type: z.literal("atlas.calls.numbers") }),
  z.object({ type: z.literal("atlas.calls.use"), id: z.string().min(1).max(100) }),
  z.object({ type: z.literal("atlas.calls.release") }),
  z.object({ type: z.literal("atlas.calls.available"), area: z.string().max(10).optional() }),
  z.object({ type: z.literal("atlas.calls.order"), number: z.string().min(4).max(20) }),
  z.object({ type: z.literal("atlas.calls.test") }),
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
  /** The files in its folder beside the SKILL.md. */
  files: Array<{ path: string; size: number }>;
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
    anthropic_api_key: boolean;
    /** Atlas's own sealing of secrets (§20): on, or why not; and a value that couldn't be opened, with the fix. */
    sealed: { state: "on" | "missing" | "short"; unreadable: string | null };
  };
  /**
   * The calendar (§10.1): which extension provides it, and `refused` when it last refused the sign-in, how many
   * times in a row, and when Atlas tries again by itself; `note` says all that in a sentence. Meanwhile Atlas
   * answers from its copy of the calendar.
   */
  calendar: {
    provider: { id: string; name: string } | null;
    refused: { at: number; message: string; tries: number; next_try: number; note: string } | null;
  };
  /** Extensions (§17): the installed ones, drafts, and the bundled ones not installed. */
  extensions: ExtensionView[];
  /** Atlas's own address (§16.2). */
  mail: MailView;
  /** Members (§7.1): who shares this Atlas. Only the owner's agent has them. */
  members: Array<{
    id: string;
    name: string;
    role: "admin" | "member";
    joined_at: number | null;
    invited_at: number;
    invite_open: boolean;
  }>;
  /** In a member's own Atlas: who they are, and whose Atlas they share. Null in the owner's. */
  me: { id: string; name: string; role: "admin" | "member"; owner: string } | null;
  /** Faces (§7.2). */
  faces: FaceView[];
  /** Chat channels (§16.1), and who the owner is on each. */
  channels: Array<{ ext: string; name: string; linked: { name: string; at: number } | null }>;
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
  /** Paired devices (Settings → Devices, §16.3). */
  nodes: import("./nodes").NodeView[];
  /** The intake's sources (Settings → Connections → Senses, §10.4): webhook sources, and each source's state. */
  senses: SensesView;
  /** Open tasks (§5.1), for Agenda's To do. */
  tasks: import("./tasks").TaskView[];
}

export interface SensesView {
  hooks: Array<{ id: string; name: string; made_at: number; last_at: number | null; refused_at: number | null }>;
  /** Each source by name: when it last sent something, and when it last worked or failed, with the provider's words. */
  sources: Array<{
    source: string;
    last: { at: number; what: string } | null;
    ok_at: number | null;
    error: string | null;
    error_at: number | null;
  }>;
}

/** One extension as Settings shows it (§17). */
/** A face as Settings shows it: its settings (§7.2). */
export type FaceView = import("./face-shape").Face & { people_names: string[]; pull_names: string[] };

/** A shared area as a member's app shows it (§6): what's in it, kept in the owner's Atlas. */
export interface SharedArea {
  id: string;
  name: string;
  about: string;
  /** Who it's shared with, by name, the owner first. */
  with: string[];
  records: Array<{ id: string; type: string; name: string; fact: string; updated_at: number; by: string }>;
}

/** Atlas's own address as Settings shows it (§16.2). */
export interface MailView {
  address: string | null;
  domain: string | null;
  on_subdomain: boolean;
  sending: string | null;
  sending_ok: boolean;
  sending_note: string | null;
  /** What the domain's account token needs. */
  permissions: string[];
  /** Extensions that can send from Atlas's address. */
  senders: Array<{ id: string; name: string }>;
}

export interface ExtensionView {
  id: string;
  name: string;
  version: string;
  about: string;
  provides: string[];
  hosts: string[];
  credit: string | null;
  costs: string | null;
  source: "bundled" | "atlas" | "owner";
  /** "available" is a bundled one that isn't installed. */
  state: "on" | "off" | "draft" | "available";
  secrets: Array<{ name: string; label: string; help: string; optional: boolean; set: boolean }>;
  settings: Array<{ name: string; label: string; help: string; optional: boolean; value: string }>;
  signin: { help: string; redirect: string | null; signed_in: boolean; secret_set: boolean } | null;
  /** Minutes between looks, when it looks on the clock. */
  every: number | null;
  /** Its address for posts, when it takes them and is installed. */
  address: string | null;
  ok_at: number | null;
  error: string | null;
  error_at: number | null;
  last_look: number | null;
  methods: string[];
  /** The code, for one Atlas or the owner wrote, so it can be read before it's installed. */
  code: string | null;
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
  /** A provider's models for the picker, or why they couldn't be listed. */
  | { type: "atlas.brain.models"; provider: string; models: Array<{ id: string; name: string }>; error?: string }
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
  /** What a pairing code names, or null when it's wrong or ran out. */
  | {
      type: "atlas.node.pairing";
      code: string;
      pairing: { code: string; name: string; kind: string; platform?: string; expires: number } | null;
    }
  /** The answer to Pair: the device's name, or null when it didn't pair. */
  | { type: "atlas.node.paired"; code: string; name: string | null }
  /** An extension's setup, shown once: what to do, a link (shown as a QR code too), and values like a password. */
  | { type: "atlas.ext.setup"; id: string; ok: boolean; text: string; link?: string; fields?: Array<{ label: string; value: string }> }
  | { type: "atlas.ext.test"; id: string; ok: boolean; message: string }
  /** Where to sign in for an extension, or why it can't start. */
  | { type: "atlas.ext.signin"; id: string; url?: string; error?: string }
  /** How setting up, taking down or testing Atlas's address went, in the provider's words when it didn't. */
  | { type: "atlas.mail"; ok: boolean; text: string }
  /** A face's answer in a test conversation. */
  | { type: "atlas.face.said"; id: string; conv: string; ok: boolean; text: string }
  | { type: "atlas.channel.code"; ext: string; code: string; expires: number }
  /** An invite link, shown once. */
  | { type: "atlas.member.invited"; id: string; name: string; link: string }
  /** The areas shared with this person (§6), with their records. */
  | { type: "atlas.shared"; areas: SharedArea[] }
  | { type: "atlas.contacts.imported"; ok: boolean; text: string }
  /** A new webhook source's address, with its key in it, shown once. */
  | { type: "atlas.sense.hook"; id: string; name: string; url: string }
  | { type: "atlas.test.result"; what: string; ref?: string; ok: boolean; message: string; detail?: unknown }
  /** Phone calls (§16.1): what an atlas.calls.* asked for, or why it couldn't. */
  | {
      type: "atlas.calls";
      ok: boolean;
      text?: string;
      numbers?: import("../../extensions/sdk").PhoneNumber[];
      offers?: import("../../extensions/sdk").NumberOffer[];
      /** The number Atlas answers now. */
      number: string | null;
    }
  | { type: "atlas.error"; message: string }
  /** This socket's sign-in was ended; the app goes back to signing in. */
  | { type: "atlas.signed_out" };
