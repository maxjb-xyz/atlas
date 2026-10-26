// Setup (§22): a passkey, meeting Atlas, a brain, a calendar, Atlas's first
// look, and the default routines, each off until the owner turns it on, then moving in from another assistant. Every
// step can be skipped and picked up again from Atlas settings → Account (moving in, from Library).

import { useEffect, useState } from "react";
import { PRESETS, type Preset } from "../../core/src/character";
import type { Atlas } from "./connection";
import { ExtensionCard } from "./abilities/Services";
import { AddPasskey, ChatGPTSignIn as ChatGPT, SecretField, TestRow } from "./settings/parts";
import { AsciiDiamond, Diamond, Icon, Toggle } from "./ui";
import type { AutomationView } from "../../core/src/protocol";
import { Switch, useAutomations } from "./pages/Automations";
import { MoveIn } from "./movein/MoveIn";

type Step = "passkey" | "meet" | "brain" | "connect" | "look" | "routines" | "movein";
const STEPS: Array<[Step, string]> = [
  ["passkey", "Your passkey"],
  ["meet", "Meet Atlas"],
  ["brain", "A brain"],
  ["connect", "Your calendar"],
  ["look", "Atlas looks"],
  ["routines", "Your routines"],
  ["movein", "Move in"],
];

export function Setup({ atlas, onDone }: { atlas: Atlas; onDone: () => void }) {
  const view = atlas.state.view;
  const setup = view?.setup;
  // Start where there's something left: the first open step, else the first one skipped.
  const [step, setStep] = useState<Step>(() => {
    const done = setup?.done ?? [];
    const skipped = setup?.skipped ?? [];
    const open = STEPS.find(([id]) => !done.includes(id) && !skipped.includes(id));
    return (open ?? STEPS.find(([id]) => !done.includes(id)) ?? STEPS[0]!)[0];
  });
  const mark = (s: Step, state: "done" | "skipped") => atlas.send({ type: "atlas.setup.step", step: s, state });
  const next = (from: Step, state: "done" | "skipped") => {
    mark(from, state);
    const i = STEPS.findIndex(([id]) => id === from);
    const after = STEPS[i + 1];
    if (after) setStep(after[0]);
    else onDone();
  };

  // A passkey made at sign-in already counts.
  useEffect(() => {
    if (view && view.passkeys.length > 0 && !setup?.done.includes("passkey")) mark("passkey", "done");
  }, [view?.passkeys.length]);

  if (!view || !setup) return <div className="center muted">Connecting to Atlas.</div>;
  const status = (s: Step) => (setup.done.includes(s) ? "done" : setup.skipped.includes(s) ? "skipped" : "open");

  return (
    <div className="center setup-page">
      <DataKey sealed={view.secrets.sealed} />
      <div className="setup rise">
        <nav className="setup-steps" aria-label="Setup steps">
          <div className="row" style={{ padding: "0 10px 14px", gap: 8 }}>
            <Diamond size={18} />
            <span className="disp">Setup</span>
          </div>
          {STEPS.map(([id, name], i) => (
            <button key={id} className={id === step ? "on" : ""} onClick={() => setStep(id)}>
              <span className="mono faint" style={{ width: 14 }}>
                {status(id) === "done" ? <Icon name="check" size={13} /> : i + 1}
              </span>
              <span className="grow">{name}</span>
              {status(id) === "skipped" && <span className="lab">Later</span>}
            </button>
          ))}
          <span className="grow" />
          <button onClick={onDone}>
            <span className="grow">Go to Atlas</span>
            <Icon name="up" size={13} style={{ transform: "rotate(90deg)" }} />
          </button>
        </nav>
        <div className="setup-body">
          {step === "passkey" && <PasskeyStep atlas={atlas} onNext={next} />}
          {step === "meet" && <MeetStep atlas={atlas} onNext={next} />}
          {step === "brain" && <BrainStep atlas={atlas} onNext={next} />}
          {step === "connect" && <ConnectStep atlas={atlas} onNext={next} />}
          {step === "look" && <LookStep atlas={atlas} onNext={next} />}
          {step === "routines" && <RoutinesStep atlas={atlas} onNext={next} />}
          {step === "movein" && <MoveInStep atlas={atlas} onNext={next} />}
        </div>
      </div>
    </div>
  );
}

type Next = (from: Step, state: "done" | "skipped") => void;

function Footer({ step, onNext, ready = true, label = "Next" }: { step: Step; onNext: Next; ready?: boolean; label?: string }) {
  return (
    <div className="row" style={{ marginTop: "auto", paddingTop: 12 }}>
      <button className="btn primary" disabled={!ready} onClick={() => onNext(step, "done")}>
        {label}
      </button>
      <button className="link" onClick={() => onNext(step, "skipped")}>
        Skip for now
      </button>
    </div>
  );
}

function PasskeyStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const has = (atlas.state.view?.passkeys.length ?? 0) > 0;
  return (
    <>
      <h1 className="disp">Your passkey</h1>
      <p className="muted">
        A passkey signs you in with your face, fingerprint or device code. Nothing to remember, and it only works on this Atlas.
      </p>
      {has ? <p className="ok">You have a passkey. You can add one for each device in Atlas settings → Account.</p> : <AddPasskey />}
      <Footer step="passkey" onNext={onNext} ready={has} />
    </>
  );
}

function MeetStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const s = atlas.state.view!.settings;
  const [name, setName] = useState(s.assistant_name);
  const [owner, setOwner] = useState(s.owner_name);
  const [preset, setPreset] = useState<Preset>(s.character.preset);
  const [voice, setVoice] = useState(s.voice.elevenlabs_voice_id);
  const hasKey = atlas.state.view!.secrets.elevenlabs_api_key;
  useEffect(() => {
    if (hasKey) atlas.send({ type: "atlas.voices.list" });
  }, [hasKey]);
  const voices = atlas.state.voices;
  const save = () =>
    atlas.send({
      type: "atlas.settings.update",
      patch: {
        assistant_name: name.trim() || "Atlas",
        owner_name: owner.trim(),
        character: { ...s.character, preset, ...PRESETS[preset].scales },
        voice: { ...s.voice, elevenlabs_voice_id: voice },
      },
    });
  return (
    <>
      <div className="row" style={{ gap: 18, flexWrap: "nowrap" }}>
        <AsciiDiamond height={140} />
        <div>
          <h1 className="disp">Hi. I'm {name || "Atlas"}.</h1>
          <p className="muted">I'll learn your world as we go. First, a few things about how I should be.</p>
        </div>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>My name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>What I call you</span>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Your first name" />
        </label>
      </div>
      <div className="field">
        <span>How I talk</span>
        <div className="cards">
          {(Object.keys(PRESETS) as Preset[]).map((p) => (
            <button key={p} className={`card ${preset === p ? "on" : ""}`} onClick={() => setPreset(p)}>
              <span style={{ fontWeight: 600 }}>{PRESETS[p].label}</span>
              <span className="muted small">{PRESETS[p].blurb}</span>
            </button>
          ))}
        </div>
        <span className="faint small">You can fine-tune this, or write your own, in Atlas settings → Atlas.</span>
      </div>
      <div className="field">
        <span>My voice</span>
        {!hasKey && (
          <>
            <p className="muted small">
              With an ElevenLabs key you can pick from their voices, and your own. Without one, I speak with Workers AI's Aura.
            </p>
            <SecretField
              label="ElevenLabs key"
              set={false}
              onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value } })}
            />
          </>
        )}
        {voices?.error && hasKey && <p className="err small">{voices.error}</p>}
        {hasKey && voices && (
          <div className="cards">
            {voices.voices.slice(0, 12).map((v) => (
              <div key={v.id} className={`card ${voice === v.id ? "on" : ""}`}>
                <span style={{ fontWeight: 600 }}>{v.name}</span>
                <span className="muted small">{v.description}</span>
                <div className="row">
                  {v.preview_url && (
                    <button className="btn sm" onClick={() => void new Audio(v.preview_url!).play()}>
                      <Icon name="play" size={11} /> Hear
                    </button>
                  )}
                  <button className="btn sm" onClick={() => setVoice(v.id)} disabled={voice === v.id}>
                    {voice === v.id ? "Chosen" : "Choose"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Footer
        step="meet"
        onNext={(st, state) => {
          if (state === "done") save();
          onNext(st, state);
        }}
      />
    </>
  );
}

function BrainStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const view = atlas.state.view!;
  const main = view.settings.brains.main;
  return (
    <>
      <h1 className="disp">A brain</h1>
      <p className="muted">
        I already work on Workers AI, which comes with your Cloudflare account. Signing in with ChatGPT makes me better, on your plan at no
        extra cost.
      </p>
      <ChatGPT chatgpt={view.chatgpt} atlas={atlas} />
      <div className="field">
        <span>Test the brains I'll use, in order</span>
        {main.map((b, i) => (
          <TestRow
            key={i}
            label={`Test ${b.provider === "chatgpt" ? "ChatGPT" : "Workers AI"} · ${b.model}`}
            k={`brain:main:${i}`}
            atlas={atlas}
            run={() => atlas.test(`brain:main:${i}`, { type: "atlas.test", what: "brain", role: "main", index: i })}
          />
        ))}
      </div>
      <Footer step="brain" onNext={onNext} />
    </>
  );
}

function ConnectStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const view = atlas.state.view!;
  const tested = atlas.state.tests.calendar;
  const connected = Boolean(view.calendar.provider);
  // A calendar is an extension (§17); iCloud and Google ship with Atlas, so both are offered here, each with what it takes.
  const icloud = view.extensions.find((e) => e.id === "icloud");
  const google = view.extensions.find((e) => e.id === "gmail");
  return (
    <>
      <h1 className="disp">Your calendar</h1>
      <p className="muted">
        So I can see your week. iCloud takes an app-specific password, about two minutes. Google takes a sign-in client of your own from
        Google Cloud, about ten minutes, once; it brings your mail too. Others you can add any time in Abilities.
      </p>
      {icloud && <ExtensionCard atlas={atlas} e={icloud} />}
      {google && <ExtensionCard atlas={atlas} e={google} />}
      <TestRow
        label="Test calendar"
        k="calendar"
        atlas={atlas}
        run={() => atlas.test("calendar", { type: "atlas.test", what: "calendar" })}
      />
      <Footer step="connect" onNext={onNext} ready={connected && tested?.ok !== false} />
    </>
  );
}

function LookStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const look = atlas.state.look;
  const [areas, setAreas] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Set<string>>(new Set());
  /** New names for proposed areas; two given the same name become one area. */
  const [names, setNames] = useState<Record<string, string>>({});
  const result = look && look !== "pending" ? look : null;
  useEffect(() => {
    if (result?.look) {
      setAreas(new Set(result.look.areas.map((a) => a.name)));
      setPeople(new Set(result.look.people.map((p) => p.name)));
      setNames({});
    }
  }, [result?.look]);
  // The look takes up to two minutes; if the answer was lost (a dropped connection), say so instead of waiting forever.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (look !== "pending") return;
    const t = setTimeout(() => setSlow(true), 150_000);
    return () => clearTimeout(t);
  }, [look]);
  const toggle = (set: Set<string>, v: string, put: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    put(n);
  };
  const keep = () => {
    for (const a of result?.look?.areas ?? [])
      if (areas.has(a.name)) atlas.send({ type: "atlas.area.create", name: (names[a.name] ?? a.name).trim() || a.name, about: a.about });
    const kept = (result?.look?.people ?? []).filter((p) => people.has(p.name));
    if (kept.length) atlas.send({ type: "atlas.setup.people", people: kept });
  };
  return (
    <>
      <h1 className="disp">Let me look</h1>
      <p className="muted">
        I'll read your calendar for the next two weeks and tell you what I see: the areas of your life, the people who matter, and a few
        things worth knowing.
      </p>
      {!look && (
        <div className="row">
          <button className="btn primary" onClick={atlas.firstLook}>
            Look now
          </button>
        </div>
      )}
      {look === "pending" && (
        <div className="row">
          <span className="mono spin ac" aria-hidden />
          <span className="muted">Reading your calendar</span>
          {slow && (
            <button className="link" onClick={atlas.firstLook}>
              This is taking too long. Try again
            </button>
          )}
        </div>
      )}
      {result?.error && (
        <p className="err small">
          {result.error}{" "}
          <button className="link" onClick={atlas.firstLook}>
            Try again
          </button>
        </p>
      )}
      {result?.look && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {result.look.notes.length > 0 && (
            <div className="panel">
              <span className="lab">Worth knowing</span>
              {result.look.notes.map((n) => (
                <p key={n} style={{ marginTop: 6 }}>
                  {n}
                </p>
              ))}
            </div>
          )}
          {result.look.areas.length > 0 && (
            <div className="field">
              <span>Areas I can see. Keep the ones that fit; rename any, and give two the same name to make them one.</span>
              {result.look.areas.map((a) => (
                <div key={a.name} className="row small" style={{ flexWrap: "nowrap" }}>
                  <Toggle label={`Keep ${a.name}`} on={areas.has(a.name)} onChange={() => toggle(areas, a.name, setAreas)} />
                  <input
                    aria-label={`Name for ${a.name}`}
                    maxLength={60}
                    value={names[a.name] ?? a.name}
                    disabled={!areas.has(a.name)}
                    onChange={(e) => setNames({ ...names, [a.name]: e.target.value })}
                    style={{ width: 160, flex: "none", fontWeight: 500 }}
                  />
                  <span className="muted">{a.about}</span>
                </div>
              ))}
            </div>
          )}
          {result.look.people.length > 0 && (
            <div className="field">
              <span>People who matter</span>
              {result.look.people.map((p) => (
                <div key={p.name} className="row small">
                  <Toggle label={`Keep ${p.name}`} on={people.has(p.name)} onChange={() => toggle(people, p.name, setPeople)} />
                  <strong>{p.name}</strong>
                  <span className="muted">{p.why}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Footer
        step="look"
        label={result?.look ? "Keep these" : "Next"}
        onNext={(st, state) => {
          if (state === "done") keep();
          onNext(st, state);
        }}
      />
    </>
  );
}

function RoutinesStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  const list = useAutomations(atlas);
  const routines = (list ?? []).filter((a) => a.made_by === "default");
  return (
    <>
      <h1 className="disp">Your routines</h1>
      <p className="muted">
        Things I can do on my own, with your calendar, reminders and what we've talked about. They're off until you turn them on, and you
        can change them any time in Automations.
      </p>
      {list == null ? (
        <p className="lab">Looking</p>
      ) : routines.length ? (
        <div className="rows">
          {routines.map((a) => (
            <RoutineRow key={a.id} atlas={atlas} a={a} />
          ))}
        </div>
      ) : (
        <p className="muted small">The default routines were deleted. You can make your own in Automations.</p>
      )}
      <Footer step="routines" onNext={onNext} />
    </>
  );
}

/** Step 7 (§22): moving in from another assistant, the last step and an optional one, picked up any time in Library. */
function MoveInStep({ atlas, onNext }: { atlas: Atlas; onNext: Next }) {
  return (
    <>
      <h1 className="disp">Move in</h1>
      <p className="muted">
        If you've used ChatGPT, Claude, Hermes or OpenClaw, I can learn what they knew about you. You choose what I keep. You can do this
        any time in Library, too.
      </p>
      <MoveIn atlas={atlas} setup />
      <Footer step="movein" label="Finish" onNext={onNext} />
    </>
  );
}

/** One routine: what it is, its time, and its switch. A new time is saved when the field is left. */
function RoutineRow({ atlas, a }: { atlas: Atlas; a: AutomationView }) {
  const t = a.when;
  const [at, setAt] = useState(t.kind === "schedule" ? t.at : "");
  const days = a.when_text.replace(/^At \S+, /, "");
  const save = () => {
    if (t.kind !== "schedule" || !at || at === t.at) return;
    atlas.send({
      type: "atlas.automation.save",
      id: a.id,
      automation: { name: a.name, about: a.about, when: { ...t, at }, do: a.steps.map((s) => s.step), report: a.report },
    });
  };
  return (
    <div className="r" style={{ alignItems: "center", gap: 12 }}>
      <span className="grow" style={{ minWidth: 0 }}>
        <strong>{a.name}</strong>
        <span className="muted small" style={{ display: "block" }}>
          {a.about.replace(/^A default routine: /, "").replace(/^./, (c) => c.toUpperCase())}
        </span>
      </span>
      {t.kind === "schedule" && (
        <span className="row" style={{ gap: 6, flex: "none" }}>
          <span className="lab faint hide-phone">{days}</span>
          <input
            type="time"
            aria-label={`${a.name} time`}
            value={at}
            onChange={(e) => setAt(e.target.value)}
            onBlur={save}
            style={{ width: 120 }}
          />
        </span>
      )}
      <Switch on={a.state === "on"} onChange={(on) => atlas.send({ type: "atlas.automation.set", id: a.id, on })} />
    </div>
  );
}

/** 32 random bytes as letters and digits: a key nobody has to make up. */
function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 40);
}

/**
 * When the deployment has no data key of its own (§20, M7 W21), setup makes one for the owner to paste into
 * Cloudflare, with exactly where, so locking their keys needs no terminal. It's made here, in the browser, and
 * never sent anywhere.
 */
function DataKey({ sealed }: { sealed: { state: "on" | "missing" | "short"; unreadable: string | null } }) {
  const [key] = useState(newKey);
  const [later, setLater] = useState(false);
  const [copied, setCopied] = useState(false);
  if (sealed.state === "on" || later) return null;
  return (
    <div className="setup-key rise">
      <span className="lab">Lock your keys</span>
      <p className="small">
        {sealed.state === "short" ? "Your ATLAS_DATA_KEY is too short to use. " : ""}
        Atlas locks your sign-ins, keys and vault with a key of its own, on top of Cloudflare's. Here's one, made in this browser:
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
        <code className="setup-key-value mono">{key}</code>
        <button
          className="btn sm"
          onClick={() =>
            navigator.clipboard
              ?.writeText(key)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="small muted">
        Keep a copy somewhere safe. In Cloudflare: Workers &amp; Pages, your Atlas, Settings, Variables and Secrets, Add, type Secret, name
        ATLAS_DATA_KEY, paste it, then Deploy. Atlas locks everything on its next start.
      </p>
      <button className="link small" onClick={() => setLater(true)}>
        Later
      </button>
    </div>
  );
}
