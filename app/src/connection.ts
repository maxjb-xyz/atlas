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
} from "../../core/src/protocol";

/** One calendar read for a page: the events, why it failed, or how old Atlas's copy is when iCloud couldn't be asked. */
export type CalendarState = { events: CalendarEventView[]; error?: string; stale?: { as_of: number; why: string } };

export type Look = Extract<ServerMessage, { type: "atlas.setup.look.result" }>["look"];

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

export interface Pending {
  client_id: string;
  text: string;
  run_id?: string;
  at: number;
}

export interface Live {
  text: string;
  status: string | null;
  surface: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  detail?: unknown;
}

export interface State {
  rows: LogRow[];
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
  voices: { voices: Array<{ id: string; name: string; preview_url: string | null; description: string }>; error?: string } | null;
  look: { look: Look; error?: string } | "pending" | null;
  /** Library's answers, by the ref they asked with. */
  records: Record<string, { records: RecordView[]; counts: Record<string, number> }>;
  /** Bumped when records change, so pages showing them ask again. */
  recordsVersion: number;
  history: { filter: HistoryFilter; rows: LogRow[]; has_more: boolean; stats?: HistoryStats } | null;
  runDetail: Record<string, { run: Record<string, unknown> | null; rows: LogRow[] }>;
  calendar: Record<string, CalendarState>;
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
  /** The page Keep just made, so the view can say where it went. */
  kept: { id: string; name: string } | null;
}

const initial: State = {
  rows: [],
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
  look: null,
  records: {},
  recordsVersion: 0,
  history: null,
  runDetail: {},
  calendar: {},
  inbox: null,
  stage: {},
  automations: null,
  suggestions: [],
  pages: null,
  files: null,
  kept: null,
};

type Action =
  | { type: "server"; msg: ServerMessage }
  | { type: "look" }
  | { type: "say"; pending: Pending }
  | { type: "test"; what: string; key: string }
  | { type: "dismiss" };

const TERMINAL = new Set(["replied", "deferred", "failed"]);

function mergeRows(a: LogRow[], b: LogRow[]): LogRow[] {
  const byId = new Map<string, LogRow>();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) byId.set(r.id, r);
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
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
        live[r.run_id] = { text: r.text ?? s.live[r.run_id]?.text ?? "", status: r.status ?? null, surface: r.surface };
      // A message Atlas never took (no run) was lost with the old socket: say so, with its words, so it can be sent again.
      const lost = s.pending.filter((p) => !p.run_id);
      const pending = s.pending.filter((p) => p.run_id && !m.thread.some((r) => r.kind === "message.in" && r.run_id === p.run_id));
      return {
        ...s,
        pending,
        ...(lost.length
          ? { error: `This didn't reach Atlas before the connection dropped: "${lost.map((p) => p.text).join(" / ")}". Send it again.` }
          : {}),
        rows: mergeRows([], m.thread),
        agenda: m.agenda,
        view: m.view,
        live,
        loaded: true,
        noOlder: false,
        jobs: m.jobs,
        areas: m.areas,
        scope: m.scope,
      };
    }
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
        if (r.kind === "message.out") live = without(live, r.run_id);
        if (r.kind === "message.in") pending = pending.filter((p) => p.run_id !== r.run_id);
      }
      const noOlder = m.older && (m.has_more === false || m.rows.length === 0) ? true : s.noOlder;
      return { ...s, rows: mergeRows(s.rows, m.rows), live, pending, noOlder, recordsVersion };
    }
    case "atlas.delta": {
      const cur = s.live[m.run_id] ?? { text: "", status: null, surface: "app" };
      return { ...s, live: { ...s.live, [m.run_id]: { ...cur, text: cur.text + m.text, status: null } } };
    }
    case "atlas.status": {
      const cur = s.live[m.run_id] ?? { text: "", status: null, surface: "app" };
      return { ...s, live: { ...s.live, [m.run_id]: { ...cur, status: m.text } } };
    }
    case "atlas.run": {
      let { pending, live } = s;
      if (m.client_id) pending = pending.map((p) => (p.client_id === m.client_id ? { ...p, run_id: m.run_id } : p));
      if (TERMINAL.has(m.state)) {
        live = without(live, m.run_id);
        pending = pending.filter((p) => p.run_id !== m.run_id);
      } else if (!live[m.run_id]) {
        live = { ...live, [m.run_id]: { text: "", status: null, surface: m.surface } };
      }
      return { ...s, pending, live };
    }
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
          [m.ref]: { events: m.events, ...(m.error ? { error: m.error } : {}), ...(m.stale ? { stale: m.stale } : {}) },
        },
      };
    case "atlas.inbox.items":
      return { ...s, inbox: m.items };
    case "atlas.stage.page":
      return { ...s, stage: { ...s.stage, [m.ref]: m.page } };
    case "atlas.automations":
      return { ...s, automations: m.automations, suggestions: m.suggestions };
    case "atlas.pages":
      return { ...s, pages: m.pages };
    case "atlas.files":
      return { ...s, files: m.files };
    case "atlas.page.kept":
      return { ...s, kept: { id: m.id, name: m.name } };
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

export function useAtlas() {
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
    const c = new VoiceClient({ agent: "PersonAgent", name: "owner", host: location.host });
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
      if (m?.type === "atlas.signed_out") {
        // This sign-in was ended (a removed passkey, or sign out everywhere): back to the sign-in page.
        c.disconnect();
        location.reload();
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

  const say = useCallback(
    (text: string) => {
      const client_id = crypto.randomUUID();
      dispatch({ type: "say", pending: { client_id, text, at: Date.now() } });
      send({ type: "atlas.say", text, client_id });
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

  const firstLook = useCallback(() => {
    dispatch({ type: "look" });
    send({ type: "atlas.setup.look" });
  }, [send]);

  return { state, voice, inCall, send, say, test, toggleCall, dismiss, firstLook };
}

export type Atlas = ReturnType<typeof useAtlas>;
