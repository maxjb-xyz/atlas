// One socket to the person agent. VoiceClient carries both the voice protocol
// and our atlas.* messages; this hook folds what arrives into thread state.

import { VoiceClient } from "agents/voice/client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgendaItem, ClientMessage, LogRow, ServerMessage, SettingsView } from "../../core/src/protocol";

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
};

type Action =
  | { type: "server"; msg: ServerMessage }
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
    case "server":
      break;
  }
  const m = a.msg;
  switch (m.type) {
    case "atlas.snapshot": {
      const live: Record<string, Live> = {};
      for (const r of m.running) live[r.run_id] = s.live[r.run_id] ?? { text: "", status: null, surface: r.surface };
      return { ...s, rows: mergeRows([], m.thread), agenda: m.agenda, view: m.view, live, loaded: true, noOlder: false };
    }
    case "atlas.rows": {
      let { live, pending } = s;
      for (const r of m.rows) {
        if (!r.run_id) continue;
        if (r.kind === "message.out") live = without(live, r.run_id);
        if (r.kind === "message.in") pending = pending.filter((p) => p.run_id !== r.run_id);
      }
      const noOlder = m.older && (m.has_more === false || m.rows.length === 0) ? true : s.noOlder;
      return { ...s, rows: mergeRows(s.rows, m.rows), live, pending, noOlder };
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
      }
    });
    c.addEventListener("custommessage", (msg) => {
      const m = msg as ServerMessage;
      if (m && typeof m === "object" && typeof m.type === "string" && m.type.startsWith("atlas.")) {
        dispatch({ type: "server", msg: m });
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

  return { state, voice, inCall, send, say, test, toggleCall, dismiss };
}

export type Atlas = ReturnType<typeof useAtlas>;
