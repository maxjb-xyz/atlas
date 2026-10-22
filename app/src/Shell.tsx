// The shell (§21.1): sidebar with the six places, the toolbar (scope switcher,
// jobs, Talk, search), one stage, and the console on Home or the composer on
// every other page. No side panes.

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LogRow, RecordView } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { Markdown } from "./Markdown";
import { Thread } from "./Thread";
import { AreaChip, AreaDot, Diamond, Icon, type Place, shortDay, useDismiss } from "./ui";

const NAV: Array<{ id: Place; label: string; icon: "home" | "inbox" | "agenda" | "automations" | "library" | "history"; gap?: boolean }> = [
  { id: "home", label: "Home", icon: "home" },
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "agenda", label: "Agenda", icon: "agenda" },
  { id: "automations", label: "Automations", icon: "automations", gap: true },
  { id: "library", label: "Library", icon: "library" },
  { id: "history", label: "History", icon: "history" },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "Me";

export function Sidebar({ atlas, place, go }: { atlas: Atlas; place: Place; go: (p: Place, d?: string) => void }) {
  const s = atlas.state;
  const settings = s.view?.settings;
  const owner = settings?.owner_name || "You";
  const inbox = s.inbox?.length ?? 0;
  const [adding, setAdding] = useState(false);
  const pins = settings?.pins ?? [];
  const setPins = (next: string[]) => atlas.send({ type: "atlas.settings.update", patch: { pins: next } });
  const pinned = pins.map((id) => s.areas.find((a) => a.id === id)).filter((a) => a != null);

  return (
    <nav className="side" aria-label="Sidebar">
      <div className="brand">
        <Diamond size={19} />
        <span className="disp">{settings?.assistant_name ?? "Atlas"}</span>
      </div>
      <div className="nav">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#/${n.id}`}
            className={`${place === n.id ? "on" : ""} ${n.gap ? "gap" : ""}`}
            aria-current={place === n.id ? "page" : undefined}
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.id === "inbox" && inbox > 0 && <span className="badge">{inbox}</span>}
          </a>
        ))}
      </div>
      <div className="pins-head">
        <span className="grow">Pinned</span>
        <button className="icon" style={{ width: 20, height: 20 }} aria-label="Pin an area" onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="pins">
        {pinned.map((a) => (
          <a
            key={a.id}
            href="#/home"
            className={s.scope === a.id ? "on" : ""}
            onClick={(e) => {
              e.preventDefault();
              atlas.send({ type: "atlas.scope.set", area: s.scope === a.id ? null : a.id });
              go("home");
            }}
          >
            <AreaDot area={a} square />
            <span className="grow">{a.name}</span>
          </a>
        ))}
        {adding && (
          <div className="pop rise" style={{ position: "relative", top: 4, marginBottom: 8 }}>
            <div className="head">
              <span className="lab">Pin an area</span>
            </div>
            {s.areas
              .filter((a) => a.state !== "archived")
              .map((a) => {
                const on = pins.includes(a.id);
                return (
                  <button
                    key={a.id}
                    className={`item ${on ? "on" : ""}`}
                    onClick={() => setPins(on ? pins.filter((p) => p !== a.id) : [...pins, a.id])}
                  >
                    <AreaDot area={a} square />
                    <span className="grow">{a.name}</span>
                    {on && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            {s.areas.length === 0 && <div className="foot">No areas yet. Atlas starts them as things come up.</div>}
          </div>
        )}
        {!pinned.length && !adding && (
          <p className="faint small" style={{ padding: "4px 8px" }}>
            Pin an area you live in.
          </p>
        )}
      </div>
      <div className="side-foot">
        <a href="#/settings" className={place === "settings" ? "on" : ""}>
          <Icon name="settings" />
          <span>Atlas settings</span>
        </a>
        <div className="me">
          <span className="avatar">{initials(owner)}</span>
          <span>{owner}</span>
        </div>
      </div>
    </nav>
  );
}

/** The phone's tab bar: Home, Inbox, Agenda, Library, and the rest under More (§21.10). */
export function TabBar({ atlas, place }: { atlas: Atlas; place: Place }) {
  const [more, setMore] = useState(false);
  const moreRef = useDismiss<HTMLElement>(more, () => setMore(false));
  const inbox = atlas.state.inbox?.length ?? 0;
  const tabs: Array<{ id: Place; label: string; icon: "home" | "inbox" | "agenda" | "library" }> = [
    { id: "home", label: "Home", icon: "home" },
    { id: "inbox", label: "Inbox", icon: "inbox" },
    { id: "agenda", label: "Agenda", icon: "agenda" },
    { id: "library", label: "Library", icon: "library" },
  ];
  return (
    <nav className="tabbar" aria-label="Places" ref={moreRef}>
      {tabs.map((t) => (
        <a key={t.id} href={`#/${t.id}`} className={place === t.id ? "on" : ""}>
          <Icon name={t.icon} size={18} />
          {t.label}
          {t.id === "inbox" && inbox > 0 && <span className="badge">{inbox}</span>}
        </a>
      ))}
      <button
        type="button"
        className={`tab ${["automations", "history", "settings"].includes(place) ? "on" : ""}`}
        aria-expanded={more}
        onClick={() => setMore(!more)}
      >
        <Icon name="more" size={18} />
        More
      </button>
      {more && (
        <div className="pop rise" role="menu" style={{ bottom: 60, top: "auto", right: 6, position: "fixed" }}>
          <a className="item" role="menuitem" href="#/automations" onClick={() => setMore(false)}>
            Automations
          </a>
          <a className="item" role="menuitem" href="#/history" onClick={() => setMore(false)}>
            History
          </a>
          <a className="item" role="menuitem" href="#/settings" onClick={() => setMore(false)}>
            Atlas settings
          </a>
        </div>
      )}
    </nav>
  );
}

export function Toolbar({ atlas, go, onSearch }: { atlas: Atlas; go: (p: Place, d?: string) => void; onSearch: () => void }) {
  const s = atlas.state;
  const [scopeOpen, setScopeOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const scoped = s.areas.find((a) => a.id === s.scope);
  const live = s.areas.filter((a) => a.state !== "archived");
  const running = s.jobs.filter((j) => j.state === "running");
  const scopeRef = useDismiss<HTMLDivElement>(scopeOpen, () => setScopeOpen(false));
  const jobsRef = useDismiss<HTMLDivElement>(jobsOpen, () => setJobsOpen(false));

  return (
    <header className="toolbar">
      <div style={{ position: "relative" }} ref={scopeRef}>
        <button className={`tb ${scopeOpen ? "on" : ""}`} onClick={() => setScopeOpen(!scopeOpen)} aria-expanded={scopeOpen}>
          <span className="dots">
            {scoped ? (
              <AreaDot area={scoped} />
            ) : (
              (live.length ? live.slice(0, 4) : [undefined, undefined, undefined, undefined]).map((a, i) => (
                <AreaDot key={a?.id ?? i} area={a} />
              ))
            )}
          </span>
          {scoped ? scoped.name : "All areas"}
          <Icon name="down" size={12} style={{ color: "var(--tx3)" }} />
        </button>
        {scopeOpen && (
          <div className="pop rise" style={{ left: 0 }}>
            <div className="head">
              <span className="lab">Focus on</span>
            </div>
            <button
              className={`item ${!s.scope ? "on" : ""}`}
              onClick={() => {
                atlas.send({ type: "atlas.scope.set", area: null });
                setScopeOpen(false);
              }}
            >
              <span className="dots">
                {live.slice(0, 4).map((a) => (
                  <AreaDot key={a.id} area={a} />
                ))}
              </span>
              <span className="grow">All areas</span>
            </button>
            {live.map((a) => (
              <button
                key={a.id}
                className={`item ${s.scope === a.id ? "on" : ""}`}
                onClick={() => {
                  atlas.send({ type: "atlas.scope.set", area: a.id });
                  setScopeOpen(false);
                }}
              >
                <AreaDot area={a} />
                <span className="grow">{a.name}</span>
              </button>
            ))}
            <div className="foot">
              {live.length
                ? "Pages filter to it and Atlas leads with it. Atlas still knows everything."
                : "No areas yet. Atlas starts them as things come up."}
            </div>
          </div>
        )}
      </div>
      <span className="conn lab">{atlas.voice.connected ? "" : "Reconnecting"}</span>
      <span className="grow" />
      {s.jobs.length > 0 && (
        <div style={{ position: "relative" }} ref={jobsRef}>
          <button className={`tb ${jobsOpen ? "on" : ""}`} onClick={() => setJobsOpen(!jobsOpen)} aria-expanded={jobsOpen}>
            {running.length > 0 && <span className="mono spin" aria-hidden style={{ color: "var(--ac)", width: 9 }} />}
            <span>{running.length > 0 ? `${running.length} ${running.length === 1 ? "job" : "jobs"} running` : "Jobs"}</span>
          </button>
          {jobsOpen && (
            <div className="pop rise" style={{ right: 0, width: 340 }}>
              <div className="head">
                <span className="lab">{running.length ? "Running now" : "Lately"}</span>
              </div>
              {s.jobs.map((j) => (
                <button
                  key={j.id}
                  className="item"
                  style={{ flexDirection: "column", alignItems: "stretch", gap: 3 }}
                  onClick={() => {
                    go("home", `jobs:${j.id}`);
                    setJobsOpen(false);
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{j.title}</span>
                  <span className="row small" style={{ gap: 10 }}>
                    <span className={j.state === "running" ? "ac mono" : j.state === "done" ? "ok mono" : "err mono"}>
                      {j.state === "running" ? "Running" : j.state === "done" ? "Done" : j.state === "failed" ? "Failed" : "Stopped"}
                    </span>
                    <span className="muted grow">{j.status ?? `${j.steps} lookups`}</span>
                    <span className="mono faint">{shortDay(j.started_at)}</span>
                  </span>
                </button>
              ))}
              <div className="foot">Click one to watch it on the stage. Finished work lands in Inbox.</div>
            </div>
          )}
        </div>
      )}
      <button className={`tb ${atlas.inCall ? "on" : ""}`} onClick={() => void atlas.toggleCall()}>
        {atlas.inCall ? "End" : "Talk"}
        <span className="kbd">Space</span>
      </button>
      <button className="tb search" onClick={onSearch} aria-label="Search">
        <Icon name="search" size={14} />
        <span className="grow label">Search</span>
        <span className="kbd">⌘K</span>
      </button>
    </header>
  );
}

// --- talking to Atlas -----------------------------------------------------------------

/** Opens the full transcript from anywhere (⌘J does the same). */
export const openTranscript = () => window.dispatchEvent(new CustomEvent("atlas:transcript"));

/**
 * The composer. Off Home, where the console shows the latest exchange, it
 * shows the one sent from it (`reply`), so what you asked and Atlas's
 * answer stay in view on the page you asked from.
 */
export function Composer({
  atlas,
  placeholder,
  chip = true,
  reply = true,
}: {
  atlas: Atlas;
  placeholder: string;
  chip?: boolean;
  reply?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const s = atlas.state;
  const [sent, setSent] = useState<{ client_id: string; text: string; at: number; run_id: string | null } | null>(null);

  // Learn the sent message's run as soon as Atlas takes it; failing that, find its row in the thread.
  const fromPending = sent && !sent.run_id ? s.pending.find((p) => p.client_id === sent.client_id)?.run_id : undefined;
  const fromRows =
    sent && !sent.run_id && !fromPending
      ? [...s.rows].reverse().find((r) => r.kind === "message.in" && r.body.text === sent.text && r.at >= sent.at - 5_000)?.run_id
      : undefined;
  useEffect(() => {
    const run = fromPending ?? fromRows;
    if (sent && !sent.run_id && run) setSent({ ...sent, run_id: run });
  }, [fromPending, fromRows]);

  useEffect(() => {
    // Other parts of the app can put words in the composer ("Ask about this").
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      ref.current?.focus();
    };
    window.addEventListener("atlas:compose", on);
    return () => window.removeEventListener("atlas:compose", on);
  }, []);

  function submit() {
    const t = text.trim();
    // While the socket is down the words stay here, rather than going nowhere.
    if (!t || !atlas.voice.connected) return;
    const client_id = atlas.say(t);
    if (reply) setSent({ client_id, text: t, at: Date.now(), run_id: null });
    setText("");
    ref.current?.focus();
  }

  const form = (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="lead">
        <Diamond size={16} />
      </span>
      <label className="sr" htmlFor="say">
        Message {s.view?.settings.assistant_name ?? "Atlas"}
      </label>
      <textarea
        id="say"
        ref={ref}
        rows={1}
        value={text}
        placeholder={atlas.voice.connected ? placeholder : "Reconnecting to Atlas. What you type waits here."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {chip && s.scope && (
        <span className="lead hide-phone">
          <AreaChip ids={[s.scope]} areas={s.areas} />
        </span>
      )}
      <button
        type="button"
        className={`icon ${atlas.inCall ? "live" : ""}`}
        aria-label={atlas.inCall ? "End voice" : "Talk"}
        onClick={() => void atlas.toggleCall()}
      >
        <Icon name="mic" />
      </button>
      <button className="send" aria-label="Send" disabled={!text.trim()}>
        <Icon name="up" size={15} style={{ strokeWidth: 2.1 }} />
      </button>
    </form>
  );
  if (!sent) return form;
  return (
    <div className="console">
      <Exchange atlas={atlas} runId={sent.run_id} asked={sent.text} onTranscript={openTranscript} onClose={() => setSent(null)} />
      {form}
    </div>
  );
}

/** Puts words in the composer from anywhere ("Ask about this"). */
export const compose = (text: string) => window.dispatchEvent(new CustomEvent("atlas:compose", { detail: text }));

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The console on Home (§21.1): the last exchange, the receipts for what
 * Atlas just did, and the composer. ⌘J opens the full transcript.
 */
export function Console({ atlas, onTranscript, onReceipt }: { atlas: Atlas; onTranscript: () => void; onReceipt: (row: LogRow) => void }) {
  const s = atlas.state;
  const name = s.view?.settings.assistant_name ?? "Atlas";
  const liveRun = Object.entries(s.live).at(-1);
  const lastIn = [...s.rows].reverse().find((r) => r.kind === "message.in");
  const pending = s.pending.at(-1);
  const runId = liveRun?.[0] ?? lastIn?.run_id ?? null;
  const asked =
    pending && !pending.run_id ? pending.text : str(s.rows.find((r) => r.kind === "message.in" && r.run_id === runId)?.body.text);
  return (
    <div className="console">
      <Exchange atlas={atlas} runId={runId} asked={asked} onTranscript={onTranscript} onReceipt={onReceipt} latest />
      <Composer atlas={atlas} placeholder={`Message ${name}`} reply={false} />
    </div>
  );
}

/**
 * One exchange: what the owner asked, Atlas's answer as it streams, and the
 * receipts for what it did. Home's console shows the latest; other pages show
 * the one sent from their composer, so a message never just disappears.
 */
function Exchange({
  atlas,
  runId,
  asked,
  onTranscript,
  onReceipt,
  onClose,
  latest = false,
}: {
  atlas: Atlas;
  runId: string | null;
  asked: string;
  onTranscript: () => void;
  onReceipt?: (row: LogRow) => void;
  onClose?: () => void;
  /** With no run yet, show the latest answer (Home); otherwise wait for this one. */
  latest?: boolean;
}) {
  const s = atlas.state;
  const name = s.view?.settings.assistant_name ?? "Atlas";
  const lastIn = [...s.rows].reverse().find((r) => r.kind === "message.in");
  const liveRun = runId ? ([runId, s.live[runId]] as const) : undefined;
  const out = runId
    ? s.rows.find((r) => r.kind === "message.out" && r.run_id === runId)
    : latest
      ? [...s.rows].reverse().find((r) => r.kind === "message.out")
      : undefined;
  const receipts = runId ? s.rows.filter((r) => r.run_id === runId && r.kind === "tool.result" && r.body.receipt) : [];
  const undone = new Set(s.rows.filter((r) => r.body.undo_of).map((r) => String(r.body.undo_of)));
  const live = liveRun?.[1];
  const failed = !live && !out && runId ? s.rows.find((r) => r.kind === "run.end" && r.run_id === runId) : undefined;
  const said = live ? live.text : str(out?.body.text);
  const at = out?.at ?? (latest ? lastIn?.at : undefined);
  // Sent, and nothing back yet: say Atlas is on it.
  const waiting = !latest && !said && !failed;

  if (!(asked || said || live)) return null;
  return (
    <div className="exchange rise" key={runId ?? "none"}>
      <div className="head">
        <span className="lab">
          {name}
          {at ? ` · ${shortDay(at)}` : ""}
        </span>
        <span className="grow" />
        <button className="chip" onClick={onTranscript}>
          Transcript <span className="kbd">⌘J</span>
        </button>
        {onClose && (
          <button className="icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {asked && <p className="asked">You: {asked}</p>}
      {said && <Markdown className="said" text={said} />}
      {((live && (live.status || !live.text)) || (waiting && !live)) && (
        <p className="lab" style={{ marginTop: 6 }}>
          {live?.status ?? "Thinking"}
        </p>
      )}
      {failed && (
        <p className="err small" style={{ marginTop: 4 }}>
          Didn't finish. {str(failed.body.error) || "The run failed."}
        </p>
      )}
      {receipts.length > 0 && (
        <div className="receipts">
          {receipts.map((r) => (
            <Receipt key={r.id} row={r} atlas={atlas} undone={undone.has(r.id)} onOpen={onReceipt ? () => onReceipt(r) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Receipt({ row, atlas, undone, onOpen }: { row: LogRow; atlas: Atlas; undone: boolean; onOpen?: () => void }) {
  const receipt = row.body.receipt as { text: string; undo?: unknown } | undefined;
  if (!receipt) return null;
  const bad = row.body.ok === false;
  return (
    <span className={`receipt ${bad ? "bad" : ""}`}>
      <span className="tick" aria-hidden>
        {bad ? "×" : "✓"}
      </span>
      {onOpen ? (
        <button className="open" onClick={onOpen} title="Open on the stage">
          {receipt.text}
        </button>
      ) : (
        <span>{receipt.text}</span>
      )}
      {undone && <span className="lab">Undone</span>}
      {receipt.undo != null && !undone && (
        <button className="link" onClick={() => atlas.send({ type: "atlas.undo", log_id: row.id })}>
          Undo
        </button>
      )}
    </span>
  );
}

// --- voice --------------------------------------------------------------------------------

export function VoiceStrip({ atlas }: { atlas: Atlas }) {
  const { status, interim, level, latencyMs } = atlas.voice;
  const label = status === "idle" ? "Starting" : status[0]!.toUpperCase() + status.slice(1);
  const live = Object.values(atlas.state.live).at(-1);
  const bars = Array.from({ length: 28 }, (_, i) =>
    Math.max(0.12, Math.min(1, level * 6 * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + level * 9))))),
  );
  return (
    <div className="voice rise">
      <Diamond size={30} />
      <div className="vbody">
        <span className={`lab ${status === "speaking" ? "ac" : ""}`}>{label}</span>
        <p className="vtext">
          {status === "speaking" && live?.text ? live.text.slice(-160) : interim || (status === "listening" ? "Go ahead." : "")}
        </p>
        <div className="wave" aria-hidden>
          {bars.map((h, i) => (
            <i key={i} style={{ transform: `scaleY(${h})` }} />
          ))}
        </div>
      </div>
      <span className="lab">{latencyMs != null ? `${Math.round(latencyMs)} ms` : ""}</span>
    </div>
  );
}

// --- ⌘J and ⌘K ------------------------------------------------------------------------------

export function Transcript({ atlas, onClose }: { atlas: Atlas; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet rise" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <span className="lab">Transcript</span>
          <span className="grow" />
          <button className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <Thread atlas={atlas} name={atlas.state.view?.settings.assistant_name ?? "Atlas"} />
      </div>
    </div>
  );
}

/** ⌘K: jump to a place, find a record, or ask Atlas. */
export function Palette({ atlas, go, onClose }: { atlas: Atlas; go: (p: Place, d?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (q.trim().length >= 2) atlas.send({ type: "atlas.records.list", ref: "palette", text: q.trim(), limit: 6 });
  }, [q]);
  const found: RecordView[] = q.trim().length >= 2 ? (atlas.state.records.palette?.records ?? []) : [];
  const places: Array<[Place, string]> = [
    ["home", "Home"],
    ["inbox", "Inbox"],
    ["agenda", "Agenda"],
    ["automations", "Automations"],
    ["library", "Library"],
    ["history", "History"],
    ["settings", "Atlas settings"],
  ];
  const items: Array<{ label: ReactNode; run: () => void }> = [
    ...places
      .filter(([, l]) => l.toLowerCase().includes(q.trim().toLowerCase()))
      .map(([p, l]) => ({ label: <>Go to {l}</>, run: () => go(p) })),
    ...found.map((r) => ({
      label: (
        <>
          <span className="lab">{r.type}</span> {r.name}
          {r.fact ? <span className="muted"> · {r.fact}</span> : null}
        </>
      ),
      run: () => go("library", `memory:${r.id}`),
    })),
    // Asked from search: the transcript opens, so the answer is in view wherever this was asked.
    ...(q.trim()
      ? [
          {
            label: <>Ask: “{q.trim()}”</>,
            run: () => {
              atlas.say(q.trim());
              openTranscript();
            },
          },
        ]
      : []),
  ];
  const pick = (i: number) => {
    items[i]?.run();
    onClose();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet rise" style={{ height: "auto", maxHeight: "70vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="Go to a place, find something, or ask"
            style={{ flex: 1, border: 0, boxShadow: "none", background: "transparent" }}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setSel((i) => Math.min(items.length - 1, i + 1));
              else if (e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
              else if (e.key === "Enter") pick(sel);
              else if (e.key === "Escape") onClose();
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="pop" style={{ position: "static", border: 0, boxShadow: "none", overflowY: "auto" }}>
          {items.map((it, i) => (
            <button key={i} className={`item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
