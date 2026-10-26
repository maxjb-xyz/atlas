import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import { type Atlas, useAtlas } from "./connection";
import { addPasskey, deviceName, inviteName, joinWithPasskey, passkeysSupported, signInWithCode, signInWithPasskey } from "./passkey";
import { Home } from "./pages/Home";
import { MOVED, SettingsPage } from "./settings";
import { Setup } from "./Setup";
import { needHref, needsYou, openConversation, Palette, Sidebar, TabBar } from "./Shell";
import { areaColor, AsciiDiamond, Diamond, Icon, ScopeColor, useRoute } from "./ui";

// Every place but Home loads when first opened, and its code is fetched in the background once the app is idle,
// so opening one is instant.
const pages = {
  history: () => import("./pages/History"),
  library: () => import("./pages/Library"),
  places: () => import("./pages/Places"),
  automations: () => import("./pages/Automations"),
  devices: () => import("./abilities/Devices"),
  abilities: () => import("./pages/Abilities"),
  people: () => import("./pages/People"),
  space: () => import("./pages/Space"),
};
const History = lazy(() => pages.history().then((m) => ({ default: m.History })));
const Library = lazy(() => pages.library().then((m) => ({ default: m.Library })));
const Agenda = lazy(() => pages.places().then((m) => ({ default: m.Agenda })));
const Inbox = lazy(() => pages.places().then((m) => ({ default: m.Inbox })));
const Automations = lazy(() => pages.automations().then((m) => ({ default: m.Automations })));
const Pair = lazy(() => pages.devices().then((m) => ({ default: m.Pair })));
const Abilities = lazy(() => pages.abilities().then((m) => ({ default: m.Abilities })));
const People = lazy(() => pages.people().then((m) => ({ default: m.People })));
const Space = lazy(() => pages.space().then((m) => ({ default: m.Space })));
const idle = (f: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(f, { timeout: 4000 }) : setTimeout(f, 2000));
idle(() => {
  for (const load of Object.values(pages)) void load().catch(() => {});
});

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

  // The keys (§21.1): ⌘K search, ⌘N a new thread, ⌘1 to ⌘9 the sidebar's rows, Tab what needs you, Esc back to Today,
  // ⌘J Today ready to type, Space to talk.
  const needs = needsYou(atlas);
  const needAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.closest("input, textarea, select, [contenteditable]") != null || t.isContentEditable);
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        go("new");
        setTimeout(() => document.getElementById("say")?.focus(), 60);
        return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        const rows = [...document.querySelectorAll<HTMLAnchorElement>(".side [data-nav]")];
        const row = rows[Number(e.key) - 1];
        if (row) {
          e.preventDefault();
          location.hash = row.getAttribute("href")!.slice(1);
        }
        return;
      }
      // ⌘J: Today, from anywhere, ready to type.
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        openConversation();
        return;
      }
      if (e.key === "Escape") {
        if (palette) return setPalette(false);
        if (!typing && !document.querySelector(".overlay, .pop") && place !== "home") go("home");
        return;
      }
      // Tab steps through what needs you, when nothing on the page has focus.
      if (e.key === "Tab" && !mod && (t == null || t === document.body) && needs.length) {
        e.preventDefault();
        const i = needAt.current % needs.length;
        needAt.current = i + 1;
        location.hash = needHref(atlas, needs[i]!).slice(1);
        return;
      }
      if (e.code !== "Space" || e.repeat) return;
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
    // The Mac app's Option-Space (M7 X12) brings this window forward and asks it to start talking.
    const onTalk = () => {
      if (!atlas.inCall) void atlas.toggleCall();
    };
    window.addEventListener("atlas:talk", onTalk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:talk", onTalk);
    };
  }, [atlas.toggleCall, atlas.inCall, palette, place, needs]);

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
  // On a phone the list of threads is its own screen, and the first one (§21.10); a wider screen always has it beside.
  const list = place === "threads" || (place === "home" && !location.hash && window.matchMedia("(max-width: 760px)").matches);
  const conversation = place === "home" || place === "thread" || place === "new" || place === "threads";
  const thread = place === "thread" ? detail.split("|")[0]! : null;
  // Each place and thread fades in when it opens, so moving between them never flashes (§21.8).
  const paneKey = place === "thread" ? `thread:${thread}` : place === "space" ? `space:${detail}` : place === "threads" ? "home" : place;

  return (
    <ScopeColor.Provider value={scoped ? areaColor(scoped) : null}>
      {/* Today and threads are conversations on the open page: the frame steps back there (M7 W14). */}
      <div className={`app ${conversation ? "focus" : ""} ${list ? "list" : ""}`}>
        <Sidebar
          atlas={atlas}
          place={place === "threads" ? "home" : place}
          detail={detail}
          onSearch={() => setPalette(true)}
          onNew={() => {
            go("new");
            setTimeout(() => document.getElementById("say")?.focus(), 60);
          }}
        />
        <div className="main">
          {error && (
            <div className="banner" style={{ margin: "10px 16px 0", position: "relative", zIndex: 6 }}>
              <span className="grow">{error}</span>
              <button className="link" onClick={atlas.dismiss}>
                Dismiss
              </button>
            </div>
          )}
          {/* On a phone, a thread or a space opens over the list; this goes back to it. */}
          {(place === "thread" || place === "space" || place === "new" || place === "home") && (
            <a className="phone-back" href="#/threads">
              <Icon name="back" size={16} />
              Threads
            </a>
          )}
          <div className="pane" key={paneKey}>
            {(place === "home" || place === "threads") && <Home atlas={atlas} detail={detail} go={sub} place={(p) => go(p)} />}
            {place === "thread" && thread && <Home atlas={atlas} detail="" go={sub} place={(p) => go(p)} thread={thread} />}
            {place === "new" && <Home atlas={atlas} detail="" go={sub} place={(p) => go(p)} fresh />}
            <Suspense fallback={<div className="stage" aria-busy="true" />}>
              {place === "space" && <Space atlas={atlas} id={detail} />}
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
        </div>
        <TabBar atlas={atlas} place={list ? "threads" : place} />
        {palette && <Palette atlas={atlas} go={go} onClose={() => setPalette(false)} />}
      </div>
    </ScopeColor.Provider>
  );
}
