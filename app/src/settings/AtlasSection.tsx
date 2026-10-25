// Atlas settings → Atlas (docs/ui §8): who Atlas is (character), how it
// sounds (voice) and how it looks (look). Character and voice are kept by the
// agent; the look is kept per device.

import { useEffect, useState } from "react";
import { PRESETS, type Preset } from "../../../core/src/character";
import type { SettingsView } from "../../../core/src/protocol";
import type { Settings as SettingsT } from "../../../core/src/store/settings";
import type { Atlas } from "../connection";
import { readTheme, themeNow, useDetail, useLook } from "../theme";
import { Diamond, Icon, Picker, pressable, Seg, Toggle } from "../ui";
import type { Edit } from "./index";
import { Head, Line, SecretField, TestRow } from "./parts";

const SCALES: Array<[k: "warmth" | "humor" | "directness" | "initiative", name: string, lo: string, hi: string]> = [
  ["warmth", "Warmth", "Reserved", "Warm"],
  ["humor", "Humor", "Serious", "Playful"],
  ["directness", "Directness", "Explains", "Brief"],
  ["initiative", "Initiative", "Waits", "Jumps in"],
];

/** What the sample answers, the same words as core's SAMPLE_PROMPT (core/src/agent/settings.ts). */
const SAMPLE_PROMPT = "I skipped the gym again today.";

type Tab = "character" | "voice" | "look";

export function AtlasSection({
  atlas,
  draft,
  edit,
  view,
  tab,
  onTab,
}: {
  atlas: Atlas;
  draft: SettingsT;
  edit: Edit;
  view: SettingsView;
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  return (
    <>
      <Head
        title="Atlas"
        sub="Who Atlas is, how it sounds, and how it looks."
        right={
          <div className="pills" role="tablist">
            {(["character", "voice", "look"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => onTab(t)}>
                {t === "character" ? "Character" : t === "voice" ? "Voice" : "Look"}
              </button>
            ))}
          </div>
        }
      />
      <div className="rise" key={tab}>
        {tab === "character" && <Character atlas={atlas} draft={draft} edit={edit} />}
        {tab === "voice" && <Voice atlas={atlas} draft={draft} edit={edit} view={view} />}
        {tab === "look" && <Look draft={draft} edit={edit} />}
      </div>
    </>
  );
}

function Character({ atlas, draft, edit }: { atlas: Atlas; draft: SettingsT; edit: Edit }) {
  const { at } = useDetail();
  const c = draft.character;
  const setC = (p: Partial<SettingsT["character"]>) => edit({ character: { ...c, ...p } });
  const sample = atlas.state.tests.sample;
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState<"text" | "presets" | null>(null);
  // Once tried, the sample follows the scales as they move.
  const shape = JSON.stringify(c);
  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => atlas.test("sample", { type: "atlas.test", what: "sample", character: c }), 700);
    return () => clearTimeout(t);
  }, [shape]);
  const preset = PRESETS[c.preset];

  return (
    <>
      <Line label="Name" center>
        <div className="row">
          <input
            maxLength={40}
            value={draft.assistant_name}
            onChange={(e) => edit({ assistant_name: e.target.value })}
            style={{ width: 200, flex: "none", fontWeight: 500 }}
            aria-label="Atlas's name"
          />
          <span className="aside">It answers to this name, out loud too.</span>
        </div>
      </Line>
      <Line label="Your name" center>
        <div className="row">
          <input
            maxLength={80}
            value={draft.owner_name}
            onChange={(e) => edit({ owner_name: e.target.value })}
            style={{ width: 200, flex: "none" }}
            aria-label="Your name"
          />
          <span className="aside">What it calls you.</span>
        </div>
      </Line>
      <Line label="Personality">
        <div className="traits">
          {SCALES.map(([k, name, lo, hi]) => (
            <div key={k} className="trait">
              <div className="row" style={{ alignItems: "baseline" }}>
                <span style={{ fontWeight: 500 }}>{name}</span>
                <span className="grow" />
                <span className="mono aside">{c[k]}/5</span>
              </div>
              <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
                <span className="aside" style={{ width: 62 }}>
                  {lo}
                </span>
                <div className="cells5">
                  {[1, 2, 3, 4, 5].map((v) => (
                    <button
                      key={v}
                      aria-label={`${name} ${v} of 5`}
                      className={v === c[k] ? "at" : v < c[k] ? "on" : ""}
                      onClick={() => setC({ [k]: v })}
                    />
                  ))}
                </div>
                <span className="aside" style={{ width: 62, textAlign: "right" }}>
                  {hi}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Line>
      <Line label="Sounds like" sub="Changes as you move the scales.">
        <div className="card2 dim sample">
          <span className="aside">You</span>
          <span className="muted">{SAMPLE_PROMPT}</span>
          <span className="row" style={{ gap: 6, fontSize: 12, fontWeight: 500, flexWrap: "nowrap" }}>
            <Diamond size={12} /> {draft.assistant_name || "Atlas"}
          </span>
          <span style={{ fontSize: 14, lineHeight: 1.5 }}>
            {asked && !sample ? (
              <span className="muted">Thinking</span>
            ) : sample ? (
              sample.message
            ) : (
              <button
                className="btn s"
                onClick={() => {
                  setAsked(true);
                  atlas.test("sample", { type: "atlas.test", what: "sample", character: c });
                }}
              >
                Hear how it answers
              </button>
            )}
          </span>
        </div>
      </Line>
      <Line label="Written character" sub="Who Atlas is, in its own words.">
        <div className="card2" style={{ padding: "12px 16px", display: "flex", gap: 18, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ lineHeight: 1.55 }}>
              {preset.blurb}
              {c.notes ? ` ${c.notes}` : ""}
            </span>
            <span className="aside">
              From the {preset.label} preset{c.notes ? ", with words of yours" : ""}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button className="btn s" onClick={() => setOpen(open === "text" ? null : "text")}>
              Edit the text
            </button>
            <button className="btn s" onClick={() => setOpen(open === "presets" ? null : "presets")}>
              Presets
            </button>
          </div>
        </div>
        {open === "text" && (
          <textarea
            className="rise"
            rows={3}
            maxLength={2_000}
            value={c.notes}
            aria-label="Anything else, in your words"
            placeholder="Anything else, in your words: Call me Max. Swear if you like."
            onChange={(e) => setC({ notes: e.target.value })}
          />
        )}
        {open === "presets" && (
          <div className="preset-grid rise">
            {(Object.keys(PRESETS) as Preset[]).map((p) => (
              <button
                key={p}
                className={`card2 ${c.preset === p ? "picked" : ""}`}
                onClick={() => setC({ preset: p, ...PRESETS[p].scales })}
              >
                <span style={{ fontWeight: 600 }}>{PRESETS[p].label}</span>
                <span className="aside">{PRESETS[p].blurb}</span>
              </button>
            ))}
          </div>
        )}
      </Line>
      {at("detailed") && (
        <Line label="Check it" sub="Sixteen prompts for each brain, each judged by another.">
          <TestRow
            label="Check character"
            k="character"
            atlas={atlas}
            run={() => atlas.test("character", { type: "atlas.test", what: "character" })}
          />
        </Line>
      )}
    </>
  );
}

function Voice({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const { at } = useDetail();
  const v = draft.voice;
  const setV = (p: Partial<SettingsT["voice"]>) => edit({ voice: { ...v, ...p } });
  const keyed = view.secrets.elevenlabs_api_key;
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (keyed) atlas.send({ type: "atlas.voices.list" });
  }, [keyed]);
  const voices = atlas.state.voices;
  const list = voices?.voices ?? [];
  // The voice in use first, then the rest; three show until "More voices".
  const ordered = [...list.filter((x) => x.id === v.elevenlabs_voice_id), ...list.filter((x) => x.id !== v.elevenlabs_voice_id)];
  const shown = all ? ordered : ordered.slice(0, 3);
  const eleven = v.speech_out === "elevenlabs";
  return (
    <>
      <Line label="Speaks with">
        <div className="row" style={{ gap: 12 }}>
          <Seg
            label="Speaks with"
            value={v.speech_out}
            options={[
              ["elevenlabs", "ElevenLabs"],
              ["workers-ai-aura", "Workers AI"],
            ]}
            onChange={(speech_out) => setV({ speech_out })}
          />
          {eleven && at("developer") && <span className="mono aside">{v.elevenlabs_model}</span>}
          {eleven && (keyed ? <span className="okdot">Connected</span> : <span className="idledot">Needs its key</span>)}
          {!eleven && <span className="okdot">Comes with Cloudflare</span>}
        </div>
        {eleven && !keyed && (
          <SecretField
            label="Your ElevenLabs key"
            set={keyed}
            onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value } })}
          />
        )}
        {eleven && voices?.error && <p className="err small">{voices.error}</p>}
        {eleven && list.length > 0 && (
          <div className="voice-grid">
            {shown.map((x) => {
              const on = x.id === v.elevenlabs_voice_id;
              return (
                <div
                  key={x.id}
                  className={`card2 voice-card ${on ? "picked" : ""}`}
                  {...pressable(() => setV({ elevenlabs_voice_id: x.id }))}
                >
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <span style={{ fontWeight: 600 }} className="clip">
                      {x.name}
                    </span>
                    <span className="aside clip grow">{x.description}</span>
                    {on && <Icon name="check" size={13} style={{ color: "var(--ok)" }} />}
                  </div>
                  {x.preview_url && (
                    <button
                      className="play"
                      aria-label={`Hear ${x.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void new Audio(x.preview_url!).play();
                      }}
                    >
                      <Icon name="play" size={9} />
                    </button>
                  )}
                </div>
              );
            })}
            {!all && list.length > 3 && (
              <button className="card2 dash voice-card" onClick={() => setAll(true)}>
                <span style={{ fontWeight: 500 }}>More voices</span>
                <span className="aside">{list.length - 3} more in your library.</span>
              </button>
            )}
          </div>
        )}
        {eleven && keyed && at("detailed") && (
          <SecretField
            label="Your ElevenLabs key"
            set={keyed}
            onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "elevenlabs_api_key", value } })}
          />
        )}
      </Line>
      <Line label="Talks like a person">
        <div className="row" style={{ gap: 28, alignItems: "flex-start" }}>
          <div className="ctl-col">
            <span className="small muted">Speed</span>
            <Seg
              label="Speed"
              value={v.speed}
              options={[0.9, 1, 1.1, 1.2].map((x) => [x, `${x.toFixed(1)}×`] as const)}
              onChange={eleven ? (speed) => setV({ speed }) : undefined}
              locked={!eleven}
            />
          </div>
          <div className="ctl-col">
            <span className="small muted">Small talk</span>
            <Seg
              label="Small talk"
              value={v.small_talk}
              options={[
                ["never", "Never"],
                ["sometimes", "Sometimes"],
                ["often", "Often"],
              ]}
              onChange={(small_talk) => setV({ small_talk })}
            />
          </div>
          <div className="ctl-col">
            <span className="small muted">Fillers like “um”</span>
            <Seg
              label="Fillers like um"
              value={v.fillers}
              options={[
                ["off", "Off"],
                ["light", "Light"],
              ]}
              onChange={(fillers) => setV({ fillers })}
            />
          </div>
        </div>
        {!eleven && <span className="aside">Speed is for ElevenLabs. Workers AI's voice speaks at one speed.</span>}
      </Line>
      <Line label="Hears with" center>
        <div className="row" style={{ gap: 12 }}>
          <Seg
            label="Hears with"
            value={v.speech_in}
            options={[
              ["workers-ai-flux", "Deepgram Flux"],
              ["elevenlabs-scribe", "ElevenLabs Scribe"],
            ]}
            onChange={(speech_in) => setV({ speech_in })}
          />
          {at("developer") && <span className="mono aside">{v.speech_in === "workers-ai-flux" ? "on Workers AI" : "ElevenLabs"}</span>}
        </div>
      </Line>
      <Line label="Try it" center>
        <TestRow label="Test the voice" k="voice" atlas={atlas} run={() => atlas.test("voice", { type: "atlas.test", what: "voice" })} />
      </Line>
    </>
  );
}

const THEMES = [
  {
    id: "graphite",
    name: "Graphite",
    sub: "Warm dark",
    bg: "#141413",
    side: "#181716",
    win: "#1b1a19",
    sep: "#2c2a28",
    tx: "#f1efea",
    tx3: "#918d86",
    ac: "#ff6a3d",
  },
  {
    id: "daylight",
    name: "Daylight",
    sub: "Light",
    bg: "#faf9f6",
    side: "#f4f3ef",
    win: "#ffffff",
    sep: "#e7e5df",
    tx: "#191817",
    tx3: "#67635d",
    ac: "#e8501b",
  },
  {
    id: "terminal",
    name: "Terminal",
    sub: "Green on black, in mono",
    bg: "#070a07",
    side: "#090c09",
    win: "#0b0f0b",
    sep: "#1c2a1c",
    tx: "#d4f5d4",
    tx3: "#82b882",
    ac: "#ff7a45",
  },
  {
    id: "midnight",
    name: "Midnight",
    sub: "Deep blue dark",
    bg: "#090d18",
    side: "#0b101d",
    win: "#0e1322",
    sep: "#1f2740",
    tx: "#e9edf7",
    tx3: "#939db6",
    ac: "#ff7346",
  },
  {
    id: "high-contrast",
    name: "High contrast",
    sub: "White on black, 7:1 or more",
    bg: "#000000",
    side: "#000000",
    win: "#000000",
    sep: "#8a8a8a",
    tx: "#ffffff",
    tx3: "#d6d6d6",
    ac: "#ff9466",
  },
] as const;

function Look({ draft, edit }: { draft: SettingsT; edit: Edit }) {
  const [look, setLook] = useLook();
  const { detail, set, at } = useDetail();
  const following = look.theme === "system";
  const current = look.theme === "custom" ? "custom" : themeNow(look);
  const [fileError, setFileError] = useState<string | null>(null);
  const takeFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const custom = readTheme(await f.text());
      setFileError(null);
      setLook({ theme: "custom", custom });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  };
  // Every zone the browser knows, so the time zone is picked, not typed.
  const zones = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  })();
  return (
    <>
      <Line label="Theme">
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button key={t.id} className="theme-card" onClick={() => setLook({ theme: t.id })} aria-pressed={current === t.id}>
              <span className="theme-pic" style={{ background: t.bg, outlineColor: current === t.id ? "var(--tx)" : "transparent" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 28,
                    background: t.side,
                    borderRight: `1px solid ${t.sep}`,
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    left: 7,
                    top: 8,
                    width: 7,
                    height: 7,
                    background: t.tx,
                    transform: "rotate(45deg) scale(.8)",
                  }}
                />
                {[24, 31, 38].map((y) => (
                  <span
                    key={y}
                    style={{ position: "absolute", left: 6, top: y, width: 14, height: 3, borderRadius: 1, background: t.tx3 }}
                  />
                ))}
                <span
                  style={{
                    position: "absolute",
                    left: 38,
                    right: 10,
                    top: 10,
                    bottom: 10,
                    borderRadius: 4,
                    background: t.win,
                    border: `1px solid ${t.sep}`,
                  }}
                >
                  <span className="disp" style={{ position: "absolute", left: 8, top: 6, fontSize: 15, color: t.tx }}>
                    Aa
                  </span>
                  <span style={{ position: "absolute", left: 8, top: 31, width: "54%", height: 3, background: t.tx3 }} />
                  <span style={{ position: "absolute", right: 7, top: 8, width: 6, height: 6, background: t.ac }} />
                  <span style={{ position: "absolute", right: 7, bottom: 6, width: 18, height: 7, borderRadius: 2, background: t.tx }} />
                </span>
              </span>
              <span className="row" style={{ gap: 6, fontWeight: 500 }}>
                {t.name}
                {current === t.id && <Icon name="check" size={12} style={{ color: "var(--ok)" }} />}
              </span>
              <span className="aside">{t.sub}</span>
            </button>
          ))}
          <label className="theme-card" aria-pressed={current === "custom"}>
            <span
              className="theme-pic dash"
              style={{ display: "grid", placeItems: "center", outlineColor: current === "custom" ? "var(--tx)" : "transparent" }}
            >
              <Icon name="plus" size={16} />
            </span>
            <span className="row" style={{ gap: 6, fontWeight: 500 }}>
              {look.custom?.name ?? "Your own"}
              {current === "custom" && <Icon name="check" size={12} style={{ color: "var(--ok)" }} />}
            </span>
            <span className="aside">
              {look.custom
                ? current === "custom"
                  ? "Its dark and light follow the system"
                  : "Pick it again, or add another file"
                : "A theme file of your own"}
            </span>
            <input type="file" accept=".json,application/json" hidden onChange={(e) => void takeFile(e.target.files?.[0])} />
          </label>
          {look.custom && current !== "custom" && (
            <button className="tbtn" onClick={() => setLook({ theme: "custom" })}>
              Use {look.custom.name}
            </button>
          )}
        </div>
        {fileError && <p className="err small">{fileError}</p>}
        {at("developer") && (
          <p className="aside">
            A theme file is JSON: a name, and dark and light tokens laid over Graphite and Daylight, like{" "}
            <span className="mono">{'{"name": "Forest", "dark": {"ac": "#4cc48f", "bg": "#0c1410"}, "light": {"ac": "#2e9a6b"}}'}</span>.
          </p>
        )}
        <div className="row" style={{ gap: 10 }}>
          <Toggle on={following} label="Follow the system" onChange={(on) => setLook({ theme: on ? "system" : current })} />
          <span style={{ fontSize: 12.5 }}>Follow the system</span>
          <span className="aside">Daylight by day, Graphite at night.</span>
        </div>
      </Line>
      <Line label="Density and motion">
        <div className="row" style={{ gap: 28, alignItems: "flex-start" }}>
          <div className="ctl-col">
            <span className="small muted">Motion</span>
            <Seg
              label="Motion"
              value={look.motion}
              options={[
                ["full", "Full"],
                ["reduced", "Reduced"],
              ]}
              onChange={(motion) => setLook({ motion })}
            />
          </div>
          <div className="ctl-col">
            <span className="small muted">Detail</span>
            <Seg
              label="Detail"
              value={detail}
              options={[
                ["simple", "Simple"],
                ["detailed", "Detailed"],
                ["developer", "Developer"],
              ]}
              onChange={set}
            />
          </div>
        </div>
        <span className="aside">Kept on this device. Developer shows ids, models and the numbers behind things.</span>
      </Line>
      <Line label="Time and units">
        <div className="row" style={{ gap: 28, alignItems: "flex-start" }}>
          <div className="ctl-col">
            <span className="small muted">Time zone</span>
            {zones.length ? (
              <Picker
                label="Time zone"
                value={draft.timezone || "UTC"}
                width={300}
                options={[...new Set([draft.timezone || "UTC", ...zones])].map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
                onPick={(timezone) => edit({ timezone })}
              />
            ) : (
              <input value={draft.timezone} placeholder="America/New_York" onChange={(e) => edit({ timezone: e.target.value })} />
            )}
          </div>
          <div className="ctl-col">
            <span className="small muted">Units</span>
            <Seg
              label="Units"
              value={draft.units}
              options={[
                ["auto", "From the time zone"],
                ["us", "°F and miles"],
                ["metric", "°C and km"],
              ]}
              onChange={(units) => edit({ units })}
            />
          </div>
        </div>
      </Line>
    </>
  );
}
