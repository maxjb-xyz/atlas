// Atlas settings (§21.2): the section list sits inside the sheet. Every
// setting has its place here (rule 6), and every check is a live test (§22).

import { useEffect, useState } from "react";
import { PRESETS, type Preset } from "../../core/src/character";
import type { ChatGPTView, SettingsView } from "../../core/src/protocol";
import type { BrainChoice, Settings as SettingsT } from "../../core/src/store/settings";
import type { Atlas, TestResult } from "./connection";
import { addPasskey, deviceName, passkeysSupported } from "./passkey";
import { Composer } from "./Shell";
import { useLook } from "./theme";
import { Icon, Sheet, shortDay, Stage } from "./ui";

type Section = "character" | "look" | "brains" | "connections" | "devices" | "data";

const SECTIONS: Array<{ group: string; items: Array<[Section, string]> }> = [
  {
    group: "Atlas",
    items: [
      ["character", "Character & voice"],
      ["look", "Look & themes"],
    ],
  },
  { group: "Brains", items: [["brains", "Brains"]] },
  {
    group: "Connected",
    items: [
      ["connections", "Connections"],
      ["devices", "Devices"],
    ],
  },
  { group: "System", items: [["data", "Your data"]] },
];

export function SettingsPage({
  atlas,
  detail,
  go,
  onSignOut,
  onSetup,
}: {
  atlas: Atlas;
  detail: string;
  go: (d: string) => void;
  onSignOut: () => void;
  onSetup: () => void;
}) {
  const view = atlas.state.view;
  const section = (SECTIONS.flatMap((g) => g.items.map(([id]) => id)).includes(detail as Section) ? detail : "character") as Section;
  const [draft, setDraft] = useState<SettingsT | null>(view?.settings ?? null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (view && !dirty) setDraft(view.settings);
  }, [view, dirty]);

  const label = SECTIONS.flatMap((g) => g.items).find(([id]) => id === section)?.[1] ?? "";
  const edit = (p: Partial<SettingsT>) => {
    if (!draft) return;
    setDraft({ ...draft, ...p });
    setDirty(true);
  };
  const save = () => {
    if (draft) atlas.send({ type: "atlas.settings.update", patch: draft });
    setDirty(false);
  };

  return (
    <Stage
      label="Settings"
      tabs={[{ id: section, label }]}
      tab={section}
      meta="Atlas · M1"
      dock={
        <div className="dock slim">
          {dirty && (
            <div className="banner rise">
              <span className="grow">You have changes that aren't saved.</span>
              <button className="btn" onClick={() => setDirty(false)}>
                Discard
              </button>
              <button className="btn primary" onClick={save}>
                Save
              </button>
            </div>
          )}
          <Composer atlas={atlas} placeholder="Change anything by asking, like: be a bit more direct" chip={false} />
        </div>
      }
    >
      <Sheet>
        <div className="settings-shell">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((g) => (
              <div key={g.group} style={{ display: "contents" }}>
                <span className="lab">{g.group}</span>
                {g.items.map(([id, name]) => (
                  <button key={id} className={id === section ? "on" : ""} onClick={() => go(id)}>
                    {name}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-body">
            {!view || !draft ? (
              <p className="muted">Loading settings.</p>
            ) : (
              <>
                {section === "character" && <Character atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "look" && <Look draft={draft} edit={edit} />}
                {section === "brains" && <Brains atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "connections" && <Connections atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "devices" && <Devices atlas={atlas} view={view} />}
                {section === "data" && <Data onSignOut={onSignOut} onSetup={onSetup} />}
              </>
            )}
          </div>
        </div>
      </Sheet>
    </Stage>
  );
}

type Edit = (p: Partial<SettingsT>) => void;

function Head({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", marginBottom: 6, flexWrap: "nowrap" }}>
      <div className="grow">
        <h1 className="disp" style={{ fontSize: 22 }}>
          {title}
        </h1>
        <p className="muted" style={{ marginTop: 2 }}>
          {sub}
        </p>
      </div>
      {right}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <span className="lab">{label}</span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

// --- Character & voice -----------------------------------------------------------------

const SCALE_ENDS: Record<"warmth" | "humor" | "directness" | "initiative", [string, string]> = {
  warmth: ["Reserved", "Warm"],
  humor: ["Serious", "Playful"],
  directness: ["Gentle", "Blunt"],
  initiative: ["Waits", "Jumps in"],
};

function Character({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const c = draft.character;
  const setC = (p: Partial<SettingsT["character"]>) => edit({ character: { ...c, ...p } });
  const sample = atlas.state.tests.sample;
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (view.secrets.elevenlabs_api_key) atlas.send({ type: "atlas.voices.list" });
  }, [view.secrets.elevenlabs_api_key]);
  const voices = atlas.state.voices;

  return (
    <>
      <Head
        title="Character & voice"
        sub="How Atlas sounds when it writes and when it talks."
        right={
          <button className="btn" onClick={() => setC({ preset: "atlas", ...PRESETS.atlas.scales, notes: "" })}>
            Reset to default
          </button>
        }
      />
      <Row label="Name">
        <div className="row">
          <input value={draft.assistant_name} onChange={(e) => edit({ assistant_name: e.target.value })} style={{ maxWidth: 220 }} />
          <span className="muted small">It answers to this name, out loud too.</span>
        </div>
        <label className="field">
          <span>What it calls you</span>
          <input value={draft.owner_name} onChange={(e) => edit({ owner_name: e.target.value })} style={{ maxWidth: 220 }} />
        </label>
      </Row>
      <Row label="Preset">
        <div className="cards">
          {(Object.keys(PRESETS) as Preset[]).map((p) => (
            <button key={p} className={`card ${c.preset === p ? "on" : ""}`} onClick={() => setC({ preset: p, ...PRESETS[p].scales })}>
              <span style={{ fontWeight: 600 }}>{PRESETS[p].label}</span>
              <span className="muted small">{PRESETS[p].blurb}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Personality">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px 28px" }}>
          {(Object.keys(SCALE_ENDS) as Array<keyof typeof SCALE_ENDS>).map((k) => (
            <div className="scale" key={k}>
              <div className="top">
                <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{k}</span>
                <span className="mono faint small">{c[k]}/5</span>
              </div>
              <div className="steps">
                <span>{SCALE_ENDS[k][0]}</span>
                {[1, 2, 3, 4, 5].map((v) => (
                  <button
                    key={v}
                    aria-label={`${k} ${v}`}
                    className={v === c[k] ? "at" : v < c[k] ? "on" : ""}
                    onClick={() => setC({ [k]: v })}
                  />
                ))}
                <span>{SCALE_ENDS[k][1]}</span>
              </div>
            </div>
          ))}
        </div>
        <label className="field">
          <span>Anything else, in your words</span>
          <textarea
            rows={2}
            value={c.notes}
            placeholder="Call me Max. Swear if you like. Don't ask me how I'm feeling."
            onChange={(e) => setC({ notes: e.target.value })}
          />
        </label>
      </Row>
      <Row label="Sounds like">
        <div className="panel" style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: "6px 12px" }}>
          <span className="lab">You</span>
          <span>I skipped the gym again today.</span>
          <span className="lab ac">{draft.assistant_name}</span>
          <span style={{ fontSize: 15 }}>
            {asked && !sample ? (
              <span className="muted">Thinking</span>
            ) : sample ? (
              sample.message
            ) : (
              <span className="faint">Press Hear it to try this character before saving.</span>
            )}
          </span>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              setAsked(true);
              atlas.test("sample", { type: "atlas.test", what: "sample", character: c });
            }}
          >
            Hear it
          </button>
          <TestRow
            label="Check character"
            k="character"
            atlas={atlas}
            run={() => atlas.test("character", { type: "atlas.test", what: "character" })}
            hint="Sixteen prompts for each brain, each judged by another brain. Takes a few minutes."
          />
        </div>
      </Row>
      <Row label="Voice">
        <div className="row">
          <span style={{ fontWeight: 500 }}>{draft.voice.speech_out === "elevenlabs" ? "ElevenLabs" : "Workers AI Aura"}</span>
          {draft.voice.speech_out === "elevenlabs" && <span className="tag">{draft.voice.elevenlabs_model}</span>}
          {view.secrets.elevenlabs_api_key ? <span className="tag ok">✓ Connected</span> : <span className="tag">No key</span>}
        </div>
        {voices?.error && <p className="muted small">{voices.error}</p>}
        {voices && voices.voices.length > 0 && (
          <div className="cards">
            {voices.voices.slice(0, 24).map((v) => {
              const on = v.id === draft.voice.elevenlabs_voice_id;
              return (
                <div key={v.id} className={`card ${on ? "on" : ""}`}>
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <span style={{ fontWeight: 600 }} className="grow">
                      {v.name}
                    </span>
                    {on && <span className="tag ac">In use</span>}
                  </div>
                  <span className="muted small" style={{ minHeight: 18 }}>
                    {v.description}
                  </span>
                  <div className="row">
                    {v.preview_url && (
                      <button className="btn sm" onClick={() => void new Audio(v.preview_url!).play()}>
                        <Icon name="play" size={11} /> Hear
                      </button>
                    )}
                    {!on && (
                      <button
                        className="btn sm"
                        onClick={() => edit({ voice: { ...draft.voice, elevenlabs_voice_id: v.id, speech_out: "elevenlabs" } })}
                      >
                        Use
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <SecretField
          label="ElevenLabs key"
          set={view.secrets.elevenlabs_api_key}
          onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value } })}
        />
        <div className="row">
          <label className="field">
            <span>Speech in</span>
            <select
              value={draft.voice.speech_in}
              onChange={(e) => edit({ voice: { ...draft.voice, speech_in: e.target.value as SettingsT["voice"]["speech_in"] } })}
            >
              <option value="workers-ai-flux">Deepgram Flux on Workers AI</option>
              <option value="elevenlabs-scribe">ElevenLabs Scribe</option>
            </select>
          </label>
          <label className="field">
            <span>Speech out</span>
            <select
              value={draft.voice.speech_out}
              onChange={(e) => edit({ voice: { ...draft.voice, speech_out: e.target.value as SettingsT["voice"]["speech_out"] } })}
            >
              <option value="elevenlabs">ElevenLabs</option>
              <option value="workers-ai-aura">Deepgram Aura on Workers AI</option>
            </select>
          </label>
          <label className="field">
            <span>Voice model</span>
            <input
              className="mono"
              value={draft.voice.elevenlabs_model}
              onChange={(e) => edit({ voice: { ...draft.voice, elevenlabs_model: e.target.value } })}
            />
          </label>
        </div>
        <TestRow label="Test voice" k="voice" atlas={atlas} run={() => atlas.test("voice", { type: "atlas.test", what: "voice" })} />
      </Row>
    </>
  );
}

// --- Look & themes ------------------------------------------------------------------------

function Look({ draft, edit }: { draft: SettingsT; edit: Edit }) {
  const [look, setLook] = useLook();
  return (
    <>
      <Head title="Look & themes" sub="Kept on this device. The theme follows your system unless you pick one." />
      <Row label="Theme">
        <div className="seg">
          {(
            [
              ["system", "Match system"],
              ["graphite", "Graphite"],
              ["daylight", "Daylight"],
            ] as const
          ).map(([id, name]) => (
            <button key={id} className={look.theme === id ? "on" : ""} onClick={() => setLook({ theme: id })}>
              {name}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Motion">
        <div className="seg">
          {(
            [
              ["full", "Full"],
              ["reduced", "Reduced"],
            ] as const
          ).map(([id, name]) => (
            <button key={id} className={look.motion === id ? "on" : ""} onClick={() => setLook({ motion: id })}>
              {name}
            </button>
          ))}
        </div>
        <p className="muted small">Reduced keeps everything still. Your system's reduced-motion setting always wins.</p>
      </Row>
      <Row label="Time zone">
        <input
          value={draft.timezone}
          placeholder="America/New_York"
          onChange={(e) => edit({ timezone: e.target.value })}
          style={{ maxWidth: 260 }}
        />
        <p className="muted small">Atlas reads and says every time in this zone.</p>
      </Row>
    </>
  );
}

// --- Brains ---------------------------------------------------------------------------------

function Brains({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  return (
    <>
      <Head title="Brains" sub="Who answers, in order. If the first can't, the next one does, and Atlas says so." />
      <Row label="ChatGPT">
        <ChatGPT chatgpt={view.chatgpt} atlas={atlas} />
      </Row>
      {(["main", "voice"] as const).map((role) => (
        <Row key={role} label={role === "main" ? "Main" : "Voice"}>
          <Chain
            role={role}
            chain={draft.brains[role]}
            view={view}
            atlas={atlas}
            onChange={(chain) => edit({ brains: { ...draft.brains, [role]: chain } })}
          />
        </Row>
      ))}
      <Row label="Quick jobs">
        <p className="muted small">
          On Workers AI: Clef decides which areas things belong to, and EmbeddingGemma remembers what things mean, for recall.
        </p>
      </Row>
    </>
  );
}

// --- Connections -------------------------------------------------------------------------------

function Connections({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  return (
    <>
      <Head title="Connections" sub="What Atlas can see. Each one has a live test." />
      <Row label="iCloud Calendar">
        <ICloud view={view} atlas={atlas} />
        <label className="field">
          <span>Calendars to leave out</span>
          <input
            value={draft.calendar.hidden.join(", ")}
            placeholder="Comma separated"
            onChange={(e) =>
              edit({
                calendar: {
                  hidden: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              })
            }
          />
        </label>
        <TestRow
          label="Test calendar"
          k="calendar"
          atlas={atlas}
          run={() => atlas.test("calendar", { type: "atlas.test", what: "calendar" })}
        />
      </Row>
      <Row label="Google, Microsoft, email">
        <p className="muted small">Not yet. Atlas connects to Google and Microsoft calendars, and reads mail, in a later version.</p>
      </Row>
    </>
  );
}

// --- Devices ----------------------------------------------------------------------------------

function Devices({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <>
      <Head title="Devices" sub="Passkeys that can sign in to Atlas. Each one only works here." />
      <Row label="Passkeys">
        <div className="rows">
          {view.passkeys.map((p) => (
            <div className="r" key={p.id}>
              <span className="grow" style={{ fontWeight: 500 }}>
                {p.name}
              </span>
              <span className="faint small">
                Added {shortDay(p.created_at)}
                {p.last_used ? ` · used ${shortDay(p.last_used)}` : ""}
              </span>
              <button className="link" onClick={() => atlas.send({ type: "atlas.passkey.remove", id: p.id })}>
                Remove
              </button>
            </div>
          ))}
          {!view.passkeys.length && <p className="muted small">No passkeys yet. Until you add one, you sign in with your setup code.</p>}
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={!passkeysSupported()}
            onClick={async () => {
              const err = await addPasskey(deviceName());
              setMsg(err ? { ok: false, text: err } : { ok: true, text: "Added. This device can sign in with its passkey now." });
            }}
          >
            Add a passkey on this device
          </button>
          {msg && <span className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
        </div>
        <p className="muted small">Lost every passkey? Your setup code still signs you in.</p>
      </Row>
    </>
  );
}

function Data({ onSignOut, onSetup }: { onSignOut: () => void; onSetup: () => void }) {
  return (
    <>
      <Head title="Your data" sub="Everything Atlas keeps lives in your own Cloudflare account." />
      <Row label="Setup">
        <div className="row">
          <button className="btn" onClick={onSetup}>
            Open setup again
          </button>
          <span className="muted small">Pick up any step you skipped.</span>
        </div>
      </Row>
      <Row label="Session">
        <div className="row">
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </Row>
    </>
  );
}

// --- parts carried over from M0 ------------------------------------------------------------------

export function TestRow({ label, k, atlas, run, hint }: { label: string; k: string; atlas: Atlas; run: () => void; hint?: string }) {
  const r = atlas.state.tests[k];
  const waiting = atlas.state.testKeys[k.split(":")[0]!] === k && !r;
  const [ran, setRan] = useState(false);
  return (
    <div className="row" title={hint}>
      <button
        className="btn"
        onClick={() => {
          setRan(true);
          run();
        }}
      >
        {label}
      </button>
      {ran && waiting && <span className="muted small">Checking</span>}
      {r && <TestMessage r={r} />}
    </div>
  );
}

function TestMessage({ r }: { r: TestResult }) {
  return <span className={`small ${r.ok ? "ok" : "err"}`}>{r.message}</span>;
}

export function SecretField({ label, set, onSave }: { label: string; set: boolean; onSave: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          placeholder={set ? "Set. Paste a new one to replace it." : "Not set"}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={value.length < 8}
          onClick={() => {
            onSave(value);
            setValue("");
          }}
        >
          Save
        </button>
        {set && (
          <button type="button" className="btn" onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
    </label>
  );
}

export function ICloud({ view, atlas }: { view: SettingsView; atlas: Atlas }) {
  const [username, setUsername] = useState(view.secrets.icloud?.username ?? "");
  const [password, setPassword] = useState("");
  const connected = view.secrets.icloud;
  return (
    <>
      <p className="muted small">
        Atlas reads iCloud Calendar with an app-specific password. Make one at{" "}
        <a href="https://account.apple.com" target="_blank" rel="noreferrer">
          account.apple.com
        </a>{" "}
        under Sign-In and Security.
      </p>
      <label className="field">
        <span>Apple ID</span>
        <input value={username} type="email" autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>App-specific password</span>
        <div className="row">
          <input
            type="password"
            className="mono"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            placeholder={connected ? "Set. Paste a new one to replace it." : "xxxx-xxxx-xxxx-xxxx"}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={username.length < 3 || password.length < 4}
            onClick={() => {
              atlas.send({ type: "atlas.secret.set", secret: { name: "icloud", value: { username, app_password: password } } });
              setPassword("");
            }}
          >
            Connect
          </button>
          {connected && (
            <button
              type="button"
              className="btn"
              onClick={() => atlas.send({ type: "atlas.secret.set", secret: { name: "icloud", value: null } })}
            >
              Disconnect
            </button>
          )}
        </div>
      </label>
      {connected?.refused && (
        <p className="err small">
          Atlas stopped asking iCloud after it refused the password at{" "}
          {new Date(connected.refused.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, so Apple doesn't lock the
          account. Paste a new app-specific password and press Connect, or press Test to try once.
        </p>
      )}
    </>
  );
}

export function ChatGPT({ chatgpt, atlas }: { chatgpt: ChatGPTView; atlas: Atlas }) {
  const [landed, setLanded] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (chatgpt.state !== "pending") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [chatgpt.state]);
  useEffect(() => {
    if (chatgpt.state !== "pending") setLanded("");
  }, [chatgpt.state]);

  return (
    <div>
      <div className="row">
        {chatgpt.state === "signed_in" && (
          <span className="muted grow">
            Signed in{chatgpt.email ? ` as ${chatgpt.email}` : ""} · {chatgpt.models.length} models on your plan
          </span>
        )}
        {(chatgpt.state === "signed_out" || chatgpt.state === "error") && <span className="muted grow">Not signed in</span>}
        {chatgpt.state === "pending" && <span className="muted grow">Waiting for you to sign in</span>}
        {chatgpt.state === "signed_in" && (
          <button className="btn" onClick={() => atlas.send({ type: "atlas.chatgpt.signout" })}>
            Sign out
          </button>
        )}
        {(chatgpt.state === "signed_out" || chatgpt.state === "error") && (
          <button className="btn" onClick={() => atlas.send({ type: "atlas.chatgpt.start" })}>
            Sign in with ChatGPT
          </button>
        )}
        {chatgpt.state === "pending" && (
          <button className="link" onClick={() => atlas.send({ type: "atlas.chatgpt.cancel" })}>
            Cancel
          </button>
        )}
      </div>
      {chatgpt.state === "pending" && (
        <div className="code-box">
          <p className="small">
            1.{" "}
            <a href={chatgpt.authorize_url} target="_blank" rel="noreferrer">
              Open ChatGPT sign-in
            </a>{" "}
            and allow Atlas to use your plan.
          </p>
          <p className="small">
            2. Your browser then lands on a page that won't load, at 127.0.0.1. That's expected. Copy that page's address and paste it here.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (landed.trim()) atlas.send({ type: "atlas.chatgpt.finish", url: landed.trim() });
            }}
          >
            <input
              className="mono"
              placeholder="http://127.0.0.1:1455/auth/callback?code=…"
              value={landed}
              onChange={(e) => setLanded(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!landed.trim()}>
              Finish
            </button>
          </form>
          <p className="lab">Expires in {countdown(chatgpt.expires_at - now)}</p>
          {chatgpt.error && <p className="err small">{chatgpt.error}</p>}
        </div>
      )}
      {chatgpt.state === "error" && <p className="err small">{chatgpt.message}</p>}
    </div>
  );
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Chain({
  role,
  chain,
  view,
  atlas,
  onChange,
}: {
  role: "main" | "voice";
  chain: BrainChoice[];
  view: SettingsView;
  atlas: Atlas;
  onChange: (c: BrainChoice[]) => void;
}) {
  const set = (i: number, b: BrainChoice) => onChange(chain.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= chain.length) return;
    const next = [...chain];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div>
      {view.chatgpt.state === "signed_in" && (
        <datalist id="chatgpt-models">
          {view.chatgpt.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
      {chain.map((b, i) => {
        const h = view.health[`${b.provider}:${b.model}`];
        const key = `brain:${role}:${i}`;
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="chain-row">
              <i className={`health ${h ? (h.ok ? "good" : "bad") : ""}`} title={h?.reason ?? (h ? "Healthy" : "Not checked yet")} />
              <select value={b.provider} onChange={(e) => set(i, { ...b, provider: e.target.value as BrainChoice["provider"] })}>
                <option value="chatgpt">ChatGPT</option>
                <option value="workers-ai">Workers AI</option>
              </select>
              <input
                className="mono"
                value={b.model}
                list={b.provider === "chatgpt" ? "chatgpt-models" : undefined}
                onChange={(e) => set(i, { ...b, model: e.target.value })}
              />
              <span className="row" style={{ gap: 2, flexWrap: "nowrap" }}>
                <button className="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon" aria-label="Move down" disabled={i === chain.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  className="icon"
                  aria-label="Remove"
                  disabled={chain.length === 1}
                  onClick={() => onChange(chain.filter((_, j) => j !== i))}
                >
                  ×
                </button>
                <button
                  className="btn sm"
                  onClick={() => atlas.test(key, { type: "atlas.test", what: "brain", choice: b })}
                  disabled={!b.model.trim()}
                >
                  Test
                </button>
              </span>
            </div>
            {atlas.state.tests[key] && <TestMessage r={atlas.state.tests[key]!} />}
          </div>
        );
      })}
      {chain.length < 5 && (
        <button className="link" onClick={() => onChange([...chain, { provider: "workers-ai", model: "" }])}>
          Add a fallback
        </button>
      )}
    </div>
  );
}
