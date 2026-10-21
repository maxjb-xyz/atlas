import { type FormEvent, useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { type Atlas, useAtlas } from "./connection";
import { Settings } from "./Settings";
import { Thread } from "./Thread";

type Session = { signed_in: boolean; configured: boolean } | null;

export function App() {
  const [session, setSession] = useState<Session>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/session", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<Session>)
      .then(setSession)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <Notice title="Atlas isn't reachable">Check your connection and reload.</Notice>;
  if (!session) return null;
  if (!session.configured) {
    return (
      <Notice title="One step left">
        Set the owner secret on your Worker, then reload this page:
        <pre className="cmd">npx wrangler secret put ATLAS_OWNER_SECRET</pre>
      </Notice>
    );
  }
  if (!session.signed_in) return <Login onDone={() => setSession({ ...session, signed_in: true })} />;
  return <Home />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center">
      <div className="card">
        <Mark size={40} />
        <h1 className="disp">{title}</h1>
        <div className="muted">{children}</div>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    }).catch(() => null);
    setBusy(false);
    if (r && r.ok) onDone();
    else setError(r?.status === 401 ? "That secret doesn't match." : "Couldn't reach Atlas. Try again.");
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <Mark size={40} />
        <h1 className="disp">Sign in to Atlas</h1>
        <p className="muted">Paste the owner secret you set when you deployed.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Owner secret"
        />
        {error && <p className="err">{error}</p>}
        <button className="btn primary" disabled={!secret || busy}>
          {busy ? "Checking" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Home() {
  const atlas = useAtlas();
  const [page, setPage] = useState<"thread" | "settings">("thread");
  const name = atlas.state.view?.settings.assistant_name ?? "Atlas";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable]") || t.isContentEditable)) return;
      e.preventDefault();
      void atlas.toggleCall();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atlas.toggleCall]);

  async function signOut() {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
    location.reload();
  }

  // The toolbar already says when the socket is reconnecting.
  const error = atlas.state.error ?? (atlas.voice.connected ? atlas.voice.error : null);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <Mark size={22} />
          <span className="disp">{name}</span>
        </div>
        <span className="lab conn">{atlas.voice.connected ? "" : "Reconnecting"}</span>
        <div className="tools">
          <button className={`btn ${atlas.inCall ? "live" : ""}`} onClick={() => void atlas.toggleCall()}>
            {atlas.inCall ? "End" : "Talk"}
            <kbd>Space</kbd>
          </button>
          <button className={`btn ${page === "settings" ? "on" : ""}`} onClick={() => setPage(page === "settings" ? "thread" : "settings")}>
            {page === "settings" ? "Close" : "Settings"}
          </button>
        </div>
      </header>

      <main className="stage">
        <div className="stage-head">
          <span className="lab">{page === "settings" ? "Settings /" : "Home /"}</span>
          <span className="lab meta">{atlas.state.view?.settings.timezone || ""}</span>
        </div>
        <section className="sheet">
          <i className="node tl" />
          <i className="node tr" />
          <i className="node bl" />
          <i className="node br" />
          {page === "settings" ? <Settings atlas={atlas} onSignOut={signOut} /> : <Thread atlas={atlas} name={name} />}
        </section>
      </main>

      <footer className="dock">
        {error && (
          <div className="banner">
            <span>{error}</span>
            <button className="link" onClick={atlas.dismiss}>
              Dismiss
            </button>
          </div>
        )}
        {atlas.inCall && <VoiceStrip atlas={atlas} />}
        <Composer atlas={atlas} />
      </footer>
    </div>
  );
}

const BARS = 24;

function VoiceStrip({ atlas }: { atlas: Atlas }) {
  const { status, interim, level, latencyMs } = atlas.voice;
  const label = status === "idle" ? "Starting" : status[0]!.toUpperCase() + status.slice(1);
  // A cheap live meter: bars scale with the mic level, staggered so it reads as a wave.
  const bars = Array.from({ length: BARS }, (_, i) => {
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + level * 9));
    return Math.max(0.08, Math.min(1, level * 6 * wobble));
  });
  return (
    <div className="voice">
      <Mark size={30} className={`vmark ${status}`} />
      <div className="vbody">
        <span className={`lab ${status === "speaking" ? "ac" : ""}`}>{label}</span>
        <p className="vtext">{interim || (status === "listening" ? "Go ahead." : "")}</p>
        <div className="meter" aria-hidden>
          {bars.map((h, i) => (
            <i key={i} style={{ transform: `scaleY(${h})` }} />
          ))}
        </div>
      </div>
      <span className="lab vlat">{latencyMs != null ? `${Math.round(latencyMs)} ms` : ""}</span>
    </div>
  );
}

function Composer({ atlas }: { atlas: Atlas }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const t = text.trim();
    if (!t) return;
    atlas.say(t);
    setText("");
    ref.current?.focus();
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Mark size={18} />
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder="Ask Atlas anything"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className={`icon ${atlas.inCall ? "live" : ""}`}
        title={atlas.inCall ? "End voice" : "Talk"}
        aria-label={atlas.inCall ? "End voice" : "Talk"}
        onClick={() => void atlas.toggleCall()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <rect x="5.5" y="1.5" width="5" height="9" rx="2.5" fill="none" stroke="currentColor" />
          <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button className="btn primary" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}
