import { type FormEvent, lazy, Suspense, useEffect, useState } from "react";
import { type Atlas, useAtlas } from "./connection";
import { addPasskey, deviceName, inviteName, joinWithPasskey, passkeysSupported, signInWithCode, signInWithPasskey } from "./passkey";
import { Home } from "./pages/Home";
// Home is what opens; every other place loads the first time it's opened, so the first paint carries only Home.
const History = lazy(() => import("./pages/History").then((m) => ({ default: m.History })));
const Library = lazy(() => import("./pages/Library").then((m) => ({ default: m.Library })));
const Agenda = lazy(() => import("./pages/Places").then((m) => ({ default: m.Agenda })));
const Inbox = lazy(() => import("./pages/Places").then((m) => ({ default: m.Inbox })));
const Automations = lazy(() => import("./pages/Automations").then((m) => ({ default: m.Automations })));
const Pair = lazy(() => import("./abilities/Devices").then((m) => ({ default: m.Pair })));
const Abilities = lazy(() => import("./pages/Abilities").then((m) => ({ default: m.Abilities })));
const People = lazy(() => import("./pages/People").then((m) => ({ default: m.People })));
import { MOVED, SettingsPage } from "./settings";
import { Setup } from "./Setup";
import { openConversation, Palette, Sidebar, TabBar, Toolbar } from "./Shell";
import { areaColor, AsciiDiamond, Diamond, ScopeColor, useRoute } from "./ui";

type Session = {
  signed_in: boolean;
  configured: boolean;
  problem?: string;
  has_passkeys: boolean;
  /** Whose Atlas this sign-in opens: the owner's, or a member's own (§7.1). */
  person?: { member: string | null; name?: string; agent: string };
} | null;

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
  // An invite link (§7.1): joining makes a passkey of their own, then opens their own Atlas.
  const join = /^#\/join\/([0-9a-f]{48})$/.exec(location.hash)?.[1];
  if (join) return <Join token={join} />;
  if (!session.signed_in) return <SignIn first={!session.has_passkeys} onDone={() => location.reload()} />;
  return <Signed agent={session.person?.agent ?? "owner"} />;
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
        <AsciiDiamond height={120} />
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

/** Joining someone's Atlas as a member, from their invite link (§7.1). */
function Join({ token }: { token: string }) {
  const [who, setWho] = useState<{ name: string } | { error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void inviteName(token).then(setWho);
  }, [token]);
  if (!who) return null;
  if ("error" in who) return <Notice title="This invite doesn't work">{who.error}</Notice>;
  return (
    <div className="center">
      <div className="solo rise">
        <AsciiDiamond height={120} />
        <h1 className="disp">Welcome, {who.name}</h1>
        <p className="muted">
          You've been invited to share an Atlas. You get one of your own: your conversations, what you tell it and your voice settings are
          yours, and nobody else can read them. Areas someone shares with you show for both of you.
        </p>
        {passkeysSupported() ? (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void joinWithPasskey(token, deviceName()).then((err) => {
                setBusy(false);
                if (err) setError(err);
                else location.replace("/");
              });
            }}
          >
            {busy ? "Waiting for your device" : "Make my passkey and join"}
          </button>
        ) : (
          <p className="err">This browser can't make passkeys. Open the link in a current browser on your phone or computer.</p>
        )}
        {error && <p className="err small">{error}</p>}
      </div>
    </div>
  );
}

function Signed({ agent }: { agent: string }) {
  const atlas = useAtlas(agent);
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  if (!atlas.state.view) return <div className="center muted">Connecting to Atlas.</div>;
  // A fresh Atlas opens on setup until every step is done or skipped; decided before the first paint, so the shell doesn't flash.
  const open = setupOpen ?? !atlas.state.view.setup.finished;
  if (open) return <Setup atlas={atlas} onDone={() => setSetupOpen(false)} />;
  return <ShellApp atlas={atlas} onSetup={() => setSetupOpen(true)} />;
}

function ShellApp({ atlas, onSetup }: { atlas: Atlas; onSetup: () => void }) {
  const [place, detail, go] = useRoute();
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.inbox" });
  }, [atlas.voice.connected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // ⌘J: the conversation, from anywhere, ready to type.
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        openConversation();
        return;
      }
      if (e.key === "Escape") setPalette(false);
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      // Space belongs to whatever has focus (a row, a link, a card that opens); it starts voice only from the page itself.
      if (
        t &&
        (t.closest("input, textarea, select, button, a, label, summary, [role=button], [role=option], [tabindex], [contenteditable]") ||
          t.isContentEditable)
      )
        return;
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

  // Sections that moved in M7 (Connections, Devices, Faces...) send old links, and sign-ins that come back to one, to their new place.
  useEffect(() => {
    if (place !== "settings") return;
    const [base = "", query] = detail.split("?");
    const moved = MOVED[base];
    if (moved) location.replace(`#/${moved[0]}/${encodeURIComponent(moved[1] + (query ? `?${query}` : ""))}`);
  }, [place, detail]);

  const error = atlas.state.error ?? (atlas.voice.connected ? atlas.voice.error : null);
  const sub = (d: string) => go(place, d);
  const scoped = atlas.state.areas.find((a) => a.id === atlas.state.scope);

  return (
    <ScopeColor.Provider value={scoped ? areaColor(scoped) : null}>
      {/* Home is the conversation on the open grid: the shell steps back there (M7 W14). */}
      <div className={`app ${place === "home" ? "focus" : ""}`}>
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
          {place === "home" && <Home atlas={atlas} detail={detail} go={sub} place={(p) => go(p)} />}
          <Suspense fallback={<div className="stage" aria-busy="true" />}>
            {place === "inbox" && <Inbox atlas={atlas} />}
            {place === "agenda" && <Agenda atlas={atlas} />}
            {place === "automations" && <Automations atlas={atlas} detail={detail} go={sub} />}
            {place === "library" && <Library atlas={atlas} detail={detail} go={sub} />}
            {place === "people" && <People atlas={atlas} detail={detail} go={sub} />}
            {place === "abilities" && <Abilities atlas={atlas} detail={detail} go={sub} place={go} />}
            {place === "history" && <History atlas={atlas} />}
            {place === "settings" && <SettingsPage atlas={atlas} detail={detail} go={sub} onSignOut={signOut} onSetup={onSetup} />}
            {place === "pair" && <Pair atlas={atlas} code={detail} />}
          </Suspense>
        </div>
        <TabBar atlas={atlas} place={place} />
        {palette && <Palette atlas={atlas} go={go} onClose={() => setPalette(false)} />}
      </div>
    </ScopeColor.Provider>
  );
}
