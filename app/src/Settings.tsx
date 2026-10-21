import { useEffect, useState } from "react";
import type { ChatGPTView, SettingsView } from "../../core/src/protocol";
import type { BrainChoice, Settings as SettingsT } from "../../core/src/store/settings";
import type { Atlas, TestResult } from "./connection";

type Role = "main" | "voice";

export function Settings({ atlas, onSignOut }: { atlas: Atlas; onSignOut: () => void }) {
  const view = atlas.state.view;
  const [draft, setDraft] = useState<SettingsT | null>(view?.settings ?? null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (view && !dirty) setDraft(view.settings);
  }, [view, dirty]);

  if (!view || !draft) return <p className="muted pad">Loading settings.</p>;

  const edit = (p: Partial<SettingsT>) => {
    setDraft({ ...draft, ...p });
    setDirty(true);
  };
  const save = () => {
    atlas.send({ type: "atlas.settings.update", patch: draft });
    setDirty(false);
  };

  return (
    <div className="settings">
      <Section title="Atlas">
        <Field label="Name">
          <input value={draft.assistant_name} onChange={(e) => edit({ assistant_name: e.target.value })} />
        </Field>
        <Field label="Your name">
          <input value={draft.owner_name} onChange={(e) => edit({ owner_name: e.target.value })} />
        </Field>
        <Field label="Time zone">
          <input value={draft.timezone} placeholder="America/New_York" onChange={(e) => edit({ timezone: e.target.value })} />
        </Field>
      </Section>

      <Section title="Brains">
        <ChatGPT chatgpt={view.chatgpt} atlas={atlas} />
        {(["main", "voice"] as Role[]).map((role) => (
          <Chain
            key={role}
            role={role}
            chain={draft.brains[role]}
            view={view}
            atlas={atlas}
            onChange={(chain) => edit({ brains: { ...draft.brains, [role]: chain } })}
          />
        ))}
      </Section>

      <Section title="Voice">
        <Field label="Speech in">
          <select
            value={draft.voice.speech_in}
            onChange={(e) => edit({ voice: { ...draft.voice, speech_in: e.target.value as SettingsT["voice"]["speech_in"] } })}
          >
            <option value="workers-ai-flux">Deepgram Flux on Workers AI</option>
            <option value="elevenlabs-scribe">ElevenLabs Scribe</option>
          </select>
        </Field>
        <Field label="Speech out">
          <select
            value={draft.voice.speech_out}
            onChange={(e) => edit({ voice: { ...draft.voice, speech_out: e.target.value as SettingsT["voice"]["speech_out"] } })}
          >
            <option value="elevenlabs">ElevenLabs</option>
            <option value="workers-ai-aura">Deepgram Aura on Workers AI</option>
          </select>
        </Field>
        <SecretField
          label="ElevenLabs key"
          set={view.secrets.elevenlabs_api_key}
          onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value } })}
        />
        <Field label="Voice ID">
          <input
            className="mono"
            value={draft.voice.elevenlabs_voice_id}
            onChange={(e) => edit({ voice: { ...draft.voice, elevenlabs_voice_id: e.target.value } })}
          />
        </Field>
        <Field label="Voice model">
          <input
            className="mono"
            value={draft.voice.elevenlabs_model}
            onChange={(e) => edit({ voice: { ...draft.voice, elevenlabs_model: e.target.value } })}
          />
        </Field>
        <TestRow label="Test voice" k="voice" atlas={atlas} run={() => atlas.test("voice", { type: "atlas.test", what: "voice" })} />
      </Section>

      <Section title="Calendar">
        <ICloud view={view} atlas={atlas} />
        <Field label="Hidden calendars">
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
        </Field>
        <TestRow
          label="Test calendar"
          k="calendar"
          atlas={atlas}
          run={() => atlas.test("calendar", { type: "atlas.test", what: "calendar" })}
          format={(r) => {
            const d = r.detail as { calendars?: string[]; events_next_30_days?: number } | undefined;
            if (r.ok && d?.calendars)
              return `Found ${d.calendars.length} calendars and ${d.events_next_30_days ?? 0} events in the next 30 days.`;
            return r.message;
          }}
        />
      </Section>

      <div className="save-bar">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        {dirty && (
          <button className="btn" onClick={() => setDirty(false)}>
            Discard
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sec">
      <h3 className="lab">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TestRow({
  label,
  k,
  atlas,
  run,
  format,
}: {
  label: string;
  k: string;
  atlas: Atlas;
  run: () => void;
  format?: (r: TestResult) => string;
}) {
  const r = atlas.state.tests[k];
  const waiting = atlas.state.testKeys[k.split(":")[0]!] === k && !r;
  const [ran, setRan] = useState(false);
  return (
    <div className="test">
      <button
        className="btn"
        onClick={() => {
          setRan(true);
          run();
        }}
      >
        {label}
      </button>
      {ran && waiting && <span className="muted">Checking</span>}
      {r && <span className={r.ok ? "ok" : "err"}>{format ? format(r) : r.message}</span>}
    </div>
  );
}

function SecretField({ label, set, onSave }: { label: string; set: boolean; onSave: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="field">
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
          <button className="btn" onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function ICloud({ view, atlas }: { view: SettingsView; atlas: Atlas }) {
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
      <Field label="Apple ID">
        <input value={username} type="email" autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <div className="field">
        <span>App password</span>
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
            <button className="btn" onClick={() => atlas.send({ type: "atlas.secret.set", secret: { name: "icloud", value: null } })}>
              Disconnect
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function ChatGPT({ chatgpt, atlas }: { chatgpt: ChatGPTView; atlas: Atlas }) {
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
    <div className="signin">
      <div className="signin-head">
        <span>ChatGPT</span>
        {chatgpt.state === "signed_in" && (
          <span className="muted">
            Signed in{chatgpt.email ? ` as ${chatgpt.email}` : ""} · {chatgpt.models.length} models on your plan
          </span>
        )}
        {(chatgpt.state === "signed_out" || chatgpt.state === "error") && <span className="muted">Not signed in</span>}
        <span className="grow" />
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
            className="paste"
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

function Chain({
  role,
  chain,
  view,
  atlas,
  onChange,
}: {
  role: Role;
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
    <div className="chain">
      {view.chatgpt.state === "signed_in" && (
        <datalist id="chatgpt-models">
          {view.chatgpt.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
      <p className="lab">{role === "main" ? "Main, in order" : "Voice, in order"}</p>
      {chain.map((b, i) => {
        const h = view.health[`${b.provider}:${b.model}`];
        const key = `brain:${role}:${i}`;
        return (
          <div key={i} className="brain">
            <i className={`dot ${h ? (h.ok ? "good" : "bad") : ""}`} title={h?.reason ?? (h ? "Healthy" : "Not checked yet")} />
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
            <div className="brain-tools">
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
                className="btn"
                onClick={() => atlas.test(key, { type: "atlas.test", what: "brain", choice: b })}
                disabled={!b.model.trim()}
              >
                Test
              </button>
            </div>
            {atlas.state.tests[key] && (
              <p className={`small ${atlas.state.tests[key]!.ok ? "ok" : "err"}`}>{atlas.state.tests[key]!.message}</p>
            )}
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
