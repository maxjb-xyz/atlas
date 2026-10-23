import { type FormEvent, useEffect, useState } from "react";
import { type Atlas, useAtlas } from "./connection";
import { addPasskey, deviceName, passkeysSupported, signInWithCode, signInWithPasskey } from "./passkey";
import { History } from "./pages/History";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { Agenda, Inbox } from "./pages/Places";
import { Automations } from "./pages/Automations";
import { Pair, SettingsPage } from "./Settings";
import { Setup } from "./Setup";
import { Palette, Sidebar, TabBar, Toolbar, Transcript } from "./Shell";
import { AsciiDiamond, Diamond, useRoute } from "./ui";

type Session = { signed_in: boolean; configured: boolean; problem?: string; has_passkeys: boolean } | null;

export function App() {
  const [session, setSession] = useState<Session>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/session", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Atlas answered ${r.status}.`);
        return (await r.json()) as Session;
      })
      .then(setSession)
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
  }, []);

  if (failed) return <Notice title="Atlas isn't reachable">{failed} Check your connection and reload.</Notice>;
  if (!session) return null;
  if (!session.configured) {
    return (
      <Notice title="One step left">
        {session.problem ?? "This deployment has no setup code yet. Set ATLAS_OWNER_SECRET on your Worker."} The Deploy button asks for it;
        after changing it, reload this page.
      </Notice>
    );
  }
  if (!session.signed_in) return <SignIn first={!session.has_passkeys} onDone={() => setSession({ ...session, signed_in: true })} />;
  return <Signed />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center">
      <div className="solo">
        <Diamond size={36} />
        <h1 className="disp">{title}</h1>
        <div className="muted">{children}</div>
      </div>
    </div>
  );
}

/**
 * Signing in (§22 step 1). On a fresh deploy the setup code adds the first
 * passkey; after that a passkey signs you in, and the code is the way back
 * in if every passkey is lost.
 */
function SignIn({ first, onDone }: { first: boolean; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(first);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (first && passkeysSupported()) await run(async () => (await addPasskey(deviceName(), code))?.error ?? null);
    else await run(() => signInWithCode(code));
  }

  return (
    <div className="center">
      <div className="solo rise">
        <AsciiDiamond rows={14} />
        <h1 className="disp">{first ? "Welcome to Atlas" : "Sign in to Atlas"}</h1>
        {useCode ? (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="muted">
              {first
                ? "Enter the setup code you chose when you deployed. Then your device makes a passkey, and you won't need the code again."
                : "Enter the setup code you chose when you deployed."}
            </p>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Setup code"
            />
            <button className="btn primary" disabled={!code || busy}>
              {busy ? "Checking" : first && passkeysSupported() ? "Make my passkey" : "Sign in"}
            </button>
            {first && passkeysSupported() && (
              <button type="button" className="link" disabled={!code || busy} onClick={() => void run(() => signInWithCode(code))}>
                Sign in without a passkey for now
              </button>
            )}
            {!first && (
              <button type="button" className="link" onClick={() => setUseCode(false)}>
                Use my passkey instead
              </button>
            )}
          </form>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void run(signInWithPasskey)}>
              {busy ? "Waiting for your passkey" : "Sign in with your passkey"}
            </button>
            <button className="link" onClick={() => setUseCode(true)}>
              Lost your passkey? Use your setup code
            </button>
          </>
        )}
        {error && <p className="err small">{error}</p>}
      </div>
    </div>
  );
}

function Signed() {
  const atlas = useAtlas();
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  if (!atlas.state.view) return <div className="center muted">Connecting to Atlas.</div>;
  // A fresh Atlas opens on setup until every step is done or skipped; decided before the first paint, so the shell doesn't flash.
  const open = setupOpen ?? !atlas.state.view.setup.finished;
  if (open) return <Setup atlas={atlas} onDone={() => setSetupOpen(false)} />;
  return <ShellApp atlas={atlas} onSetup={() => setSetupOpen(true)} />;
}

function ShellApp({ atlas, onSetup }: { atlas: Atlas; onSetup: () => void }) {
  const [place, detail, go] = useRoute();
  const [transcript, setTranscript] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.inbox" });
  }, [atlas.voice.connected]);

  // Going somewhere, such as opening a view on the stage from the transcript, closes the transcript.
  useEffect(() => setTranscript(false), [place, detail]);

  useEffect(() => {
    const open = () => setTranscript(true);
    window.addEventListener("atlas:transcript", open);
    return () => window.removeEventListener("atlas:transcript", open);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setTranscript((t) => !t);
        return;
      }
      if (e.key === "Escape") {
        setPalette(false);
        setTranscript(false);
      }
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

  const error = atlas.state.error ?? (atlas.voice.connected ? atlas.voice.error : null);
  const sub = (d: string) => go(place, d);

  return (
    <div className="app">
      <Sidebar atlas={atlas} place={place} go={go} />
      <div className="main">
        <Toolbar atlas={atlas} go={go} onSearch={() => setPalette(true)} />
        {error && (
          <div className="banner" style={{ margin: "8px 16px 0", position: "relative", zIndex: 6 }}>
            <span className="grow">{error}</span>
            <button className="link" onClick={atlas.dismiss}>
              Dismiss
            </button>
          </div>
        )}
        {place === "home" && <Home atlas={atlas} detail={detail} go={sub} onTranscript={() => setTranscript(true)} />}
        {place === "inbox" && <Inbox atlas={atlas} />}
        {place === "agenda" && <Agenda atlas={atlas} />}
        {place === "automations" && <Automations atlas={atlas} detail={detail} go={sub} />}
        {place === "library" && <Library atlas={atlas} detail={detail} go={sub} />}
        {place === "history" && <History atlas={atlas} />}
        {place === "settings" && <SettingsPage atlas={atlas} detail={detail} go={sub} onSignOut={signOut} onSetup={onSetup} />}
        {place === "pair" && <Pair atlas={atlas} code={detail} />}
      </div>
      <TabBar atlas={atlas} place={place} />
      {transcript && <Transcript atlas={atlas} onClose={() => setTranscript(false)} />}
      {palette && <Palette atlas={atlas} go={go} onClose={() => setPalette(false)} />}
    </div>
  );
}
