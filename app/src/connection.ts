// One socket to the person agent. VoiceClient carries both the voice protocol
// and our atlas.* messages; this hook folds what arrives into thread state.

import type { SuggestionView } from "../../core/src/suggestions";
import { VoiceClient } from "agents/voice/client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { deviceId, inView } from "./notify";
import type {
  AgendaItem,
  AreaView,
  CalendarEventView,
  ClientMessage,
  HistoryFilter,
  HistoryStats,
  InboxItem,
  JobView,
  LogRow,
  RecordView,
  ServerMessage,
  SettingsView,
  StagePage,
  AutomationView,
  PageSummary,
  ThreadView,
} from "../../core/src/protocol";

/** One calendar read for a page: the events, why it failed, or how old Atlas's copy is when iCloud couldn't be asked. */
export type CalendarState = {
  events: CalendarEventView[];
  error?: string;
  stale?: { as_of: number; why: string };
  /** Calendars that couldn't be read at all, each with why. */
  missing?: string[];
};

export type Look = Extract<ServerMessage, { type: "atlas.setup.look.result" }>["look"];

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

export interface Pending {
  client_id: string;
  text: string;
  run_id?: string;
  at: number;
  /** The thread it was said in (§21.1): null for Today, `new:<client_id>` until a new thread's id comes back. */
  thread?: string | null;
}

export interface Live {
  text: string;
  status: string | null;
  surface: string;
  /** A turn of work Atlas owns: it shows in that job's own thread, not the main one. */
  job?: string;
  /** The thread the run is in (§21.1); null or missing for Today. */
  thread?: string | null;
  /** Where in its words each thing it did landed (a tool result's row id at a length of `text`), so they read in order. */
  marks?: Array<{ at: number; id: string }>;
}

export interface TestResult {
  ok: boolean;
  message: string;
  detail?: unknown;
}

export interface State {
  /** Today's rows (§21.1): the line to Atlas outside any thread. */
  rows: LogRow[];
  /** The owner's threads (§21.1), most recent first. */
  threads: ThreadView[];
  /** Each thread's rows once it has been opened (or something arrived in it), oldest first. */
  threadRows: Record<string, LogRow[]>;
  /** Threads whose first page has come back, and whether older rows are left to read. */
  threadLoaded: Record<string, { more: boolean }>;
  /** Which thread each run is in, from its rows: null for Today. */
  runThread: Record<string, string | null>;
  /** New threads' ids, by the client id the app asked with (or the row a split started from). */
  made: Record<string, string>;
  /** Each space's feed (§21.3), once asked for. */
  feeds: Record<string, LogRow[]>;
  /** ⌘K's latest answer (M7 W20): what matched, for the words it was asked with. */
  search: { text: string; hits: import("../../core/src/protocol").SearchHit[] } | null;
  pending: Pending[];
  live: Record<string, Live>;
  agenda: AgendaItem[];
  view: SettingsView | null;
  tests: Record<string, TestResult>;
  testKeys: Record<string, string>;
  error: string | null;
  loaded: boolean;
  noOlder: boolean;
  jobs: JobView[];
  areas: AreaView[];
  scope: string | null;
  /** Each provider's live list of models (§18), once asked for. */
  models: Record<string, { models: import("../../core/src/brains/catalog").ModelInfo[]; error?: string }>;
  /** The phone's last answer (§16.1): numbers, numbers to buy, and what happened. */
  calls: Extract<ServerMessage, { type: "atlas.calls" }> | null;
  voices: { voices: Array<{ id: string; name: string; preview_url: string | null; description: string }>; error?: string } | null;
  look: { look: Look; error?: string } | "pending" | null;
  /** Library's answers, by the ref they asked with. */
  records: Record<string, { records: RecordView[]; counts: Record<string, number> }>;
  /** Bumped when records change, so pages showing them ask again. */
  recordsVersion: number;
  history: { filter: HistoryFilter; rows: LogRow[]; has_more: boolean; stats?: HistoryStats } | null;
  runDetail: Record<string, { run: Record<string, unknown> | null; rows: LogRow[] }>;
  calendar: Record<string, CalendarState>;
  /** Bumped when events' areas change, so pages showing the calendar ask again. */
  calendarVersion: number;
  inbox: InboxItem[] | null;
  /** The live pages behind area and person views, by the ref they asked with. */
  stage: Record<string, StagePage | null>;
  /** The automations, once asked for; the agent sends them again whenever they change. */
  automations: AutomationView[] | null;
  /** Automations Atlas suggests from requests the owner repeats, shown at the top of Automations. */
  suggestions: SuggestionView[];
  /** The owner's pages (§21.7), once asked for. */
  pages: PageSummary[] | null;
  files: import("../../core/src/stage").FileRow[] | null;
  /** What the workspace is printing for Atlas right now (a progress hint; the tool's result is the truth). */
  workspaceOut: { run_id: string; text: string } | null;
  skills: import("../../core/src/protocol").SkillView[] | null;
  /** Connected MCP servers (§9.2), once asked for. */
  mcpServers: import("../../core/src/protocol").McpServerView[] | null;
  /** The services catalog (§17): one card per service, whatever is underneath, and the indexes it reads. */
  services: import("../../core/src/protocol").ServiceView[] | null;
  /** The last thing a service's install, key, removal or update said. */
  serviceNote: { id: string; ok: boolean; text: string } | null;
  /** Get skills (§17): the catalog's skill hubs and what each holds, once asked for. */
  hubs: import("../../core/src/protocol").HubView[] | null;
  /** The hub skill opened in full before it's installed, or why it couldn't be fetched. */
  hubPreview: { hub: string; name: string; preview?: import("../../core/src/protocol").HubPreview; error?: string } | null;
  /** The last thing installing or removing a hub's skill said. */
  hubNote: { hub: string; name: string; ok: boolean; text: string } | null;
  /** The page Keep just made, so the view can say where it went. */
  kept: { id: string; name: string } | null;
  /** Bumped when the situation changes, so Now and the situation, weather and place views ask again. */
  situationVersion: number;
  /** OwnTracks' setup, shown once in Abilities → Devices. */
  /** An extension's setup, shown once (a link and its QR code, a password), by the extension's id. */
  extSetup: Record<string, { ok: boolean; text: string; link?: string; fields?: Array<{ label: string; value: string }> }>;
  /** A face's answers in "talk to it as a stranger", by test conversation (§7.2). */
  faceSaid: Record<string, Array<{ ok: boolean; text: string }>>;
  /** The invite link just made, shown once (§7.1). */
  invited: { id: string; name: string; link: string } | null;
  /** The areas shared between the owner and members, with what's in them (§6). */
  shared: import("../../core/src/protocol").SharedArea[] | null;
  /** The code to link a chat channel, shown until it's sent from the owner's account (§16.1). */
  channelCode: { ext: string; code: string; expires: number } | null;
  /** A webhook source just added: its address with its key, shown once. */
  senseHook: { id: string; name: string; url: string } | null;
  /** Pairing codes looked up (null: not waiting), and the answer to Pair (the device's name, or null), by code. */
  pairing: Record<string, { name: string; kind: string; platform?: string; expires: number } | null>;
  paired: Record<string, string | null>;
  /** A job's own thread (§21.4), once asked for: its updates, questions, result and the owner's words to it, oldest first. */
  jobThreads: Record<string, LogRow[]>;
  /** The owner's answers sent from this app, by the question row they answer, so the question shows its answer at once. */
  answered: Record<string, string>;
  /** Moving in (§23.3): the readers, what's been read and the review list. */
  movein: import("../../core/src/protocol").MoveInView | null;
}

const initial: State = {
  rows: [],
  threads: [],
  threadRows: {},
  threadLoaded: {},
  runThread: {},
  made: {},
  feeds: {},
  search: null,
  pending: [],
  live: {},
  agenda: [],
  view: null,
  tests: {},
  testKeys: {},
  error: null,
  loaded: false,
  noOlder: false,
  jobs: [],
  areas: [],
  scope: null,
  voices: null,
  models: {},
  calls: null,
  look: null,
  records: {},
  recordsVersion: 0,
  history: null,
  runDetail: {},
  calendar: {},
  calendarVersion: 0,
  inbox: null,
  stage: {},
  automations: null,
  suggestions: [],
  pages: null,
  files: null,
  workspaceOut: null,
  skills: null,
  mcpServers: null,
  services: null,
  serviceNote: null,
  hubs: null,
  hubPreview: null,
  hubNote: null,
  kept: null,
  situationVersion: 0,
  extSetup: {},
  faceSaid: {},
  channelCode: null,
  invited: null,
  shared: null,
  senseHook: null,
  pairing: {},
  paired: {},
  jobThreads: {},
  answered: {},
  movein: null,
};

type Action =
  | { type: "server"; msg: ServerMessage }
  | { type: "look" }
  | { type: "say"; pending: Pending }
  | { type: "test"; what: string; key: string }
  | { type: "answered"; question: string; text: string }
  | { type: "dismiss" };

const TERMINAL = new Set(["replied", "deferred", "failed"]);

function mergeRows(a: LogRow[], b: LogRow[]): LogRow[] {
  const byId = new Map<string, LogRow>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}

/** The job a log row belongs to, when it's one of a job's own rows (§21.4). */
export function jobOf(r: LogRow): string | null {
  if (r.kind === "job.result") return typeof r.body.item_id === "string" ? r.body.item_id : null;
  if (["job.update", "job.question", "message.in", "message.out", "settings.change", "tool.result"].includes(r.kind))
    return typeof r.body.job === "string" ? r.body.job : null;
  return null;
}

/** Whether a row is the note that a message went to a thread (§21.1): it stays where the message was said. */
export const isThreadNote = (r: LogRow) => (r.body.receipt as { undo?: { kind?: string } } | undefined)?.undo?.kind === "thread.move";

/** Rows sorted into Today's and each thread's, by the thread each one says it's in. */
function sortRows(s: State, rows: LogRow[]): Pick<State, "rows" | "threadRows" | "runThread"> {
  const today: LogRow[] = [];
  const by: Record<string, LogRow[]> = {};
  let runThread = s.runThread;
  for (const r of rows) {
    const t = r.thread ?? null;
    if (r.run_id && !isThreadNote(r) && runThread[r.run_id] !== t) runThread = { ...runThread, [r.run_id]: t };
    if (t) (by[t] ??= []).push(r);
    else today.push(r);
  }
  let threadRows = s.threadRows;
  for (const [t, list] of Object.entries(by)) threadRows = { ...threadRows, [t]: mergeRows(threadRows[t] ?? [], list) };
  return { rows: today.length ? mergeRows(s.rows, today) : s.rows, threadRows, runThread };
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "say":
      return { ...s, pending: [...s.pending, a.pending] };
    case "test":
      return { ...s, testKeys: { ...s.testKeys, [a.what]: a.key }, tests: without(s.tests, a.key) };
    case "dismiss":
      return { ...s, error: null };
    case "answered":
      return { ...s, answered: { ...s.answered, [a.question]: a.text } };
    case "look":
      return { ...s, look: "pending" };
    case "server":
      break;
  }
  const m = a.msg;
  switch (m.type) {
    case "atlas.snapshot": {
      const live: Record<string, Live> = {};
      // What a run in progress has said so far comes back with the snapshot, so a refresh mid-answer picks up there.
      for (const r of m.running)
        live[r.run_id] = {
          text: r.text ?? s.live[r.run_id]?.text ?? "",
          status: r.status ?? null,
          surface: r.surface,
          thread: (r as { thread?: string | null }).thread ?? null,
        };
      // A message Atlas never took (no run) was lost with the old socket: say so, with its words, so it can be sent again.
      const lost = s.pending.filter((p) => !p.run_id);
      const pending = s.pending.filter((p) => p.run_id && !m.thread.some((r) => r.kind === "message.in" && r.run_id === p.run_id));
      return {
        ...s,
        pending,
        ...(lost.length
          ? { error: `This didn't reach Atlas before the connection dropped: "${lost.map((p) => p.text).join(" / ")}". Send it again.` }
          : {}),
        // Today's rows; anything in a thread goes to that thread.
        ...sortRows({ ...s, rows: [] }, m.thread),
        agenda: m.agenda,
        view: m.view,
        live,
        loaded: true,
        noOlder: false,
        jobs: m.jobs,
        areas: m.areas,
        scope: m.scope,
        // A server from before threads sends none.
        threads: m.threads ?? [],
      };
    }
    case "atlas.threads":
      return { ...s, threads: m.threads };
    case "atlas.thread.rows": {
      const sorted = sortRows({ ...s, threadRows: { ...s.threadRows, [m.id]: s.threadRows[m.id] ?? [] } }, m.rows);
      return {
        ...s,
        ...sorted,
        threadLoaded: {
          ...s.threadLoaded,
          [m.id]: { more: m.has_more ?? false },
        },
      };
    }
    case "atlas.thread.made": {
      const pending = s.pending.map((p) => (p.thread === `new:${m.client_id}` ? { ...p, thread: m.id } : p));
      return { ...s, pending, made: { ...s.made, [m.client_id]: m.id } };
    }
    case "atlas.thread.moved": {
      // A run's rows go where the run went; the note that it went stays where it was said.
      const moves = (r: LogRow) => r.run_id === m.run_id && !isThreadNote(r);
      const moving = [...s.rows, ...Object.values(s.threadRows).flat()].filter(moves).map((r) => ({ ...r, thread: m.thread }));
      const threadRows = Object.fromEntries(Object.entries(s.threadRows).map(([k, v]) => [k, v.filter((r) => !moves(r))]));
      const base = { ...s, rows: s.rows.filter((r) => !moves(r)), threadRows, runThread: { ...s.runThread, [m.run_id]: m.thread } };
      const live = s.live[m.run_id] ? { ...s.live, [m.run_id]: { ...s.live[m.run_id]!, thread: m.thread } } : s.live;
      return { ...base, ...sortRows(base, moving), live };
    }
    case "atlas.space.feed":
      return { ...s, feeds: { ...s.feeds, [m.area]: m.rows } };
    case "atlas.rows": {
      let { live, pending, recordsVersion } = s;
      // A fact saved, corrected or forgotten from any composer, or undone from a chip: Library reads again.
      if (
        m.rows.some((r) => r.kind === "record.change" || (r.kind === "tool.result" && ["remember", "forget"].includes(String(r.body.name))))
      ) {
        recordsVersion += 1;
      }
      for (const r of m.rows) {
        if (!r.run_id) continue;
        const l = live[r.run_id];
        if (r.kind === "tool.result" && l && !l.marks?.some((x) => x.id === r.id))
          live = { ...live, [r.run_id]: { ...l, marks: [...(l.marks ?? []), { at: l.text.length, id: r.id }] } };
        if (r.kind === "message.out") live = without(live, r.run_id);
        if (r.kind === "message.in") pending = pending.filter((p) => p.run_id !== r.run_id);
      }
      const noOlder = m.older && (m.has_more === false || m.rows.length === 0) ? true : s.noOlder;
      // A job's own thread, once open, keeps up with what's said on it.
      let { jobThreads } = s;
      for (const r of m.rows) {
        const job = jobOf(r);
        if (job && jobThreads[job]) jobThreads = { ...jobThreads, [job]: mergeRows(jobThreads[job], [r]) };
      }
      return { ...s, ...sortRows(s, m.rows), live, pending, noOlder, recordsVersion, jobThreads };
    }
    case "atlas.delta": {
      const cur = s.live[m.run_id] ?? {
        text: "",
        status: null,
        surface: "app",
        thread: s.runThread[m.run_id] ?? null,
        ...(m.job ? { job: m.job } : {}),
      };
      return { ...s, live: { ...s.live, [m.run_id]: { ...cur, text: cur.text + m.text, status: null } } };
    }
    case "atlas.status": {
      const cur = s.live[m.run_id] ?? {
        text: "",
        status: null,
        surface: "app",
        thread: s.runThread[m.run_id] ?? null,
        ...(m.job ? { job: m.job } : {}),
      };
      return { ...s, live: { ...s.live, [m.run_id]: { ...cur, status: m.text } } };
    }
    case "atlas.run": {
      let { pending, live, runThread } = s;
      const mine = m.client_id ? pending.find((p) => p.client_id === m.client_id) : undefined;
      if (m.client_id) pending = pending.map((p) => (p.client_id === m.client_id ? { ...p, run_id: m.run_id } : p));
      // Where the run is: from its rows, else from what was sent here.
      const where =
        runThread[m.run_id] !== undefined ? runThread[m.run_id]! : mine?.thread?.startsWith("new:") ? null : (mine?.thread ?? null);
      if (mine && runThread[m.run_id] === undefined && mine.thread && !mine.thread.startsWith("new:"))
        runThread = { ...runThread, [m.run_id]: mine.thread };
      if (TERMINAL.has(m.state)) {
        live = without(live, m.run_id);
        pending = pending.filter((p) => p.run_id !== m.run_id);
      } else if (!live[m.run_id]) {
        live = { ...live, [m.run_id]: { text: "", status: null, surface: m.surface, thread: where, ...(m.job ? { job: m.job } : {}) } };
      }
      return { ...s, pending, live, runThread };
    }
    case "atlas.job.thread":
      return { ...s, jobThreads: { ...s.jobThreads, [m.id]: mergeRows([], m.rows) } };
    case "atlas.agenda":
      return { ...s, agenda: m.agenda };
    case "atlas.view":
      return { ...s, view: m.view };
    case "atlas.test.result": {
      const key = m.ref ?? s.testKeys[m.what] ?? m.what;
      return { ...s, tests: { ...s.tests, [key]: { ok: m.ok, message: m.message, detail: m.detail } } };
    }
    case "atlas.error":
      return { ...s, error: m.message };
    case "atlas.jobs":
      return { ...s, jobs: m.jobs };
    case "atlas.areas":
      return { ...s, areas: m.areas, scope: m.scope };
    case "atlas.brain.models":
      return { ...s, models: { ...s.models, [m.provider]: { models: m.models, ...(m.error ? { error: m.error } : {}) } } };
    case "atlas.calls":
      return { ...s, calls: m };
    case "atlas.voices":
      return { ...s, voices: { voices: m.voices, ...(m.error ? { error: m.error } : {}) } };
    case "atlas.setup.look.result":
      return { ...s, look: { look: m.look, ...(m.error ? { error: m.error } : {}) } };
    case "atlas.records":
      return { ...s, records: { ...s.records, [m.ref]: { records: m.records, counts: m.counts } } };
    case "atlas.records.changed":
      return { ...s, recordsVersion: s.recordsVersion + 1 };
    case "atlas.history.rows": {
      const keep = m.older && s.history?.filter === m.filter ? s.history.rows : [];
      return { ...s, history: { filter: m.filter, rows: [...keep, ...m.rows], has_more: m.has_more, stats: m.stats ?? s.history?.stats } };
    }
    case "atlas.run.detail.result":
      return { ...s, runDetail: { ...s.runDetail, [m.run_id]: { run: m.run, rows: m.rows } } };
    case "atlas.calendar.events":
      return {
        ...s,
        calendar: {
          ...s.calendar,
          [m.ref]: {
            events: m.events,
            ...(m.error ? { error: m.error } : {}),
            ...(m.stale ? { stale: m.stale } : {}),
            ...(m.missing ? { missing: m.missing } : {}),
          },
        },
      };
    case "atlas.calendar.changed":
      return { ...s, calendarVersion: s.calendarVersion + 1 };
    case "atlas.inbox.items":
      return { ...s, inbox: m.items };
    case "atlas.search.results":
      return { ...s, search: { text: m.text, hits: m.hits } };
    case "atlas.stage.page":
      return { ...s, stage: { ...s.stage, [m.ref]: m.page } };
    case "atlas.automations":
      return { ...s, automations: m.automations, suggestions: m.suggestions };
    case "atlas.pages":
      return { ...s, pages: m.pages };
    case "atlas.files":
      return { ...s, files: m.files };
    case "atlas.skills":
      return { ...s, skills: m.skills };
    case "atlas.mcp.servers":
      return { ...s, mcpServers: m.servers };
    case "atlas.services":
      return { ...s, services: m.services };
    case "atlas.service.done":
      return { ...s, serviceNote: { id: m.id, ok: m.ok, text: m.text } };
    case "atlas.hubs":
      return { ...s, hubs: m.hubs };
    case "atlas.hub.preview":
      return {
        ...s,
        hubPreview: { hub: m.hub, name: m.name, ...(m.preview ? { preview: m.preview } : {}), ...(m.error ? { error: m.error } : {}) },
      };
    case "atlas.hub.done":
      return { ...s, hubNote: { hub: m.hub, name: m.name, ok: m.ok, text: m.text } };
    case "atlas.workspace.out": {
      const prev = s.workspaceOut?.run_id === m.run_id ? s.workspaceOut.text : "";
      return { ...s, workspaceOut: { run_id: m.run_id, text: (prev + m.text).slice(-40_000) } };
    }
    case "atlas.page.kept":
      return { ...s, kept: { id: m.id, name: m.name } };
    case "atlas.node.pairing":
      return { ...s, pairing: { ...s.pairing, [m.code]: m.pairing } };
    case "atlas.node.paired":
      return { ...s, paired: { ...s.paired, [m.code]: m.name } };
    case "atlas.situation":
      return { ...s, situationVersion: s.situationVersion + 1 };
    case "atlas.ext.setup":
      return {
        ...s,
        extSetup: {
          ...s.extSetup,
          [m.id]: { ok: m.ok, text: m.text, ...(m.link ? { link: m.link } : {}), ...(m.fields ? { fields: m.fields } : {}) },
        },
      };
    case "atlas.ext.test":
      return { ...s, tests: { ...s.tests, [`ext:${m.id}`]: { ok: m.ok, message: m.message } } };
    case "atlas.ext.signin":
      // The sign-in page, in this tab: it sends the owner back to Settings when it's done.
      if (m.url) window.location.assign(m.url);
      return m.error ? { ...s, tests: { ...s.tests, [`ext:${m.id}`]: { ok: false, message: m.error } } } : s;
    case "atlas.face.said":
      return { ...s, faceSaid: { ...s.faceSaid, [m.conv]: [...(s.faceSaid[m.conv] ?? []), { ok: m.ok, text: m.text }] } };
    case "atlas.member.invited":
      return { ...s, invited: { id: m.id, name: m.name, link: m.link } };
    case "atlas.shared":
      return { ...s, shared: m.areas };
    case "atlas.channel.code":
      return { ...s, channelCode: { ext: m.ext, code: m.code, expires: m.expires } };
    case "atlas.mail":
      return { ...s, tests: { ...s.tests, mail: { ok: m.ok, message: m.text } } };
    case "atlas.updates":
      return { ...s, tests: { ...s.tests, updates: { ok: m.ok, message: m.text } } };
    case "atlas.data.preview":
      return {
        ...s,
        tests: { ...s.tests, "data.preview": { ok: m.ok, message: m.text, detail: { at: m.at, lost: m.lost, kept: m.kept } } },
      };
    case "atlas.data":
      return { ...s, tests: { ...s.tests, data: { ok: m.ok, message: m.text, detail: { what: m.what, left: m.left ?? [] } } } };
    case "atlas.contacts.imported":
      return { ...s, tests: { ...s.tests, contacts: { ok: m.ok, message: m.text } } };
    case "atlas.movein":
      return { ...s, movein: m.movein };
    case "atlas.sense.hook":
      return { ...s, senseHook: { id: m.id, name: m.name, url: m.url } };
  }
  return s;
}

export interface VoiceState {
  connected: boolean;
  status: VoiceStatus;
  interim: string | null;
  level: number;
  latencyMs: number | null;
  error: string | null;
}

/** The connection to one person's Atlas: the owner's, or a member's own (§7.1). */
export function useAtlas(agent = "owner") {
  const [state, dispatch] = useReducer(reduce, initial);
  const [voice, setVoice] = useState<VoiceState>({
    connected: false,
    status: "idle",
    interim: null,
    level: 0,
    latencyMs: null,
    error: null,
  });
  const client = useRef<VoiceClient | null>(null);
  const [inCall, setInCall] = useState(false);

  useEffect(() => {
    const c = new VoiceClient({ agent: "PersonAgent", name: agent, host: location.host });
    client.current = c;
    const patch = (p: Partial<VoiceState>) => setVoice((v) => ({ ...v, ...p }));
    c.addEventListener("connectionchange", (connected) => {
      patch(connected ? { connected, error: null } : { connected });
      if (connected) {
        c.sendJSON({ type: "atlas.hello", tz: Intl.DateTimeFormat().resolvedOptions().timeZone } satisfies ClientMessage);
        c.sendJSON({ type: "atlas.presence", device: deviceId(), visible: inView() } satisfies ClientMessage);
      }
    });
    // Whether Atlas is in view here decides whether a message also needs a push (§14: one channel).
    const presence = () => c.sendJSON({ type: "atlas.presence", device: deviceId(), visible: inView() } satisfies ClientMessage);
    document.addEventListener("visibilitychange", presence);
    c.addEventListener("custommessage", (msg) => {
      const m = msg as ServerMessage;
      // Everything was deleted (§23.4): the page says what's left; there's no Atlas to reconnect to until it's set up again.
      if (m?.type === "atlas.data" && m.what === "delete" && m.ok) c.disconnect();
      if (m?.type === "atlas.signed_out") {
        // This sign-in was ended (a removed passkey, or sign out everywhere): back to the sign-in page.
        c.disconnect();
        location.reload();
        return;
      }
      // An MCP App's frame waits for its own answers by `req`; they go to it, not the state.
      if (m?.type === "atlas.mcp.app.result" || m?.type === "atlas.mcp.app.answer") {
        window.dispatchEvent(new CustomEvent("atlas:mcp", { detail: m }));
        return;
      }
      if (m && typeof m === "object" && typeof m.type === "string" && m.type.startsWith("atlas.")) {
        dispatch({ type: "server", msg: m });
        // A job changed or a run failed: what's waiting in the Inbox may have too.
        if (m.type === "atlas.jobs" || (m.type === "atlas.run" && m.state === "failed")) {
          c.sendJSON({ type: "atlas.inbox" } satisfies ClientMessage);
        }
      }
    });
    c.addEventListener("statuschange", (status) => {
      patch({ status });
      if (status === "idle") setInCall(false);
    });
    c.addEventListener("interimtranscript", (interim) => patch({ interim }));
    c.addEventListener("audiolevelchange", (level) => patch({ level }));
    c.addEventListener("turnmetrics", (t) => patch({ latencyMs: t.finalInputToFirstAudioMs ?? t.modelToFirstTextMs ?? null }));
    c.addEventListener("error", (error) => patch({ error }));
    c.connect();
    return () => {
      document.removeEventListener("visibilitychange", presence);
      c.disconnect();
      client.current = null;
    };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    client.current?.sendJSON(m as unknown as Record<string, unknown>);
  }, []);

  /** Says something in Today, or in a thread (§21.1). */
  const say = useCallback(
    (text: string, thread: string | null = null) => {
      const client_id = crypto.randomUUID();
      dispatch({ type: "say", pending: { client_id, text, at: Date.now(), thread } });
      send({ type: "atlas.say", text, client_id, ...(thread ? { thread } : {}) });
      return client_id;
    },
    [send],
  );

  /** Starts a thread (§21.1), in a space when `areas` names one, saying `text` in it at once. Its id comes back in `made`. */
  const startThread = useCallback(
    (o: { text?: string; areas?: string[]; title?: string } = {}) => {
      const client_id = crypto.randomUUID();
      if (o.text) dispatch({ type: "say", pending: { client_id, text: o.text, at: Date.now(), thread: `new:${client_id}` } });
      send({
        type: "atlas.thread.new",
        client_id,
        ...(o.text ? { text: o.text } : {}),
        ...(o.areas?.length ? { areas: o.areas } : {}),
        ...(o.title ? { title: o.title } : {}),
      });
      return client_id;
    },
    [send],
  );

  const test = useCallback(
    (key: string, m: Extract<ClientMessage, { type: "atlas.test" }>) => {
      dispatch({ type: "test", what: m.what, key });
      send({ ...m, ref: key });
    },
    [send],
  );

  const toggleCall = useCallback(async () => {
    const c = client.current;
    if (!c) return;
    if (inCall) {
      c.endCall();
      setInCall(false);
    } else {
      setInCall(true);
      try {
        await c.startCall();
      } catch (e) {
        setInCall(false);
        setVoice((v) => ({ ...v, error: e instanceof Error ? e.message : "Couldn't start the microphone." }));
      }
    }
  }, [inCall]);

  const dismiss = useCallback(() => {
    dispatch({ type: "dismiss" });
    setVoice((v) => ({ ...v, error: null }));
  }, []);

  /** The owner's words for a job (§21.4): an answer to one of its questions when `answers` names it, or words on its card. */
  const jobSay = useCallback(
    (id: string, text: string, answers?: string) => {
      if (answers) dispatch({ type: "answered", question: answers, text });
      send({ type: "atlas.job.say", id, text, ...(answers ? { answers } : {}) });
    },
    [send],
  );

  const firstLook = useCallback(() => {
    dispatch({ type: "look" });
    send({ type: "atlas.setup.look" });
  }, [send]);

  return { state, voice, inCall, send, say, startThread, test, toggleCall, dismiss, firstLook, jobSay };
}

export type Atlas = ReturnType<typeof useAtlas>;
