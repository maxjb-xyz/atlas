// Atlas settings (§21.2): the section list sits inside the sheet. Every
// setting has its place here (rule 6), and every check is a live test (§22).

import { useEffect, useState } from "react";
import { PRESETS, type Preset } from "../../core/src/character";
import type { ChatGPTView, SettingsView } from "../../core/src/protocol";
import type { BrainChoice, Settings as SettingsT } from "../../core/src/store/settings";
import type { Atlas, TestResult } from "./connection";
import { deviceId, type PushState, pushState, subscribe, unsubscribe } from "./notify";
import { addPasskey, deviceName, passkeysSupported } from "./passkey";
import { Composer } from "./Shell";
import { useLook } from "./theme";
import { clock, Icon, QrCode, Sheet, shortDay, Stage } from "./ui";
import { MAPS, type MapsProvider } from "../../core/src/maps";
import { Markdown } from "./Markdown";
import { PROVIDERS, type SearchProvider } from "../../core/src/web";
import { FIELDS, type VaultKind } from "../../core/src/vault-fields";

type Section = "character" | "look" | "brains" | "connections" | "devices" | "vault" | "skills" | "permissions" | "notifications" | "data";

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
      ["vault", "Vault"],
    ],
  },
  {
    group: "Abilities",
    items: [
      ["skills", "Skills"],
      ["permissions", "Permissions"],
    ],
  },
  {
    group: "System",
    items: [
      ["notifications", "Notifications"],
      ["data", "Your data"],
    ],
  },
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
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (view && !dirty) setDraft(view.settings);
  }, [view, dirty]);

  const label = SECTIONS.flatMap((g) => g.items).find(([id]) => id === section)?.[1] ?? "";
  const edit = (p: Partial<SettingsT>) => {
    if (!draft) return;
    setDraft({ ...draft, ...p });
    setDirty(true);
    setProblem(null);
  };
  const save = () => {
    if (!draft || !view) return;
    const why = draftProblem(draft);
    // Kept as it is, so nothing typed is lost; the banner says what to fix.
    if (why) return setProblem(why);
    // Only what changed, so a change made elsewhere meanwhile (a pin, a sign-in) isn't undone.
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(view.settings[k as keyof SettingsT])),
    );
    if (Object.keys(changed).length) atlas.send({ type: "atlas.settings.update", patch: changed });
    setDirty(false);
  };

  return (
    <Stage
      label="Settings"
      tabs={[{ id: section, label }]}
      tab={section}
      meta="Atlas · M4"
      dock={
        <div className="dock slim">
          {dirty && (
            <div className="banner rise">
              <span className={`grow ${problem ? "err" : ""}`}>{problem ?? "You have changes that aren't saved."}</span>
              <button
                className="btn"
                onClick={() => {
                  setDirty(false);
                  setProblem(null);
                }}
              >
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
                {section === "vault" && <Vault atlas={atlas} view={view} />}
                {section === "skills" && <Skills atlas={atlas} />}
                {section === "permissions" && <Permissions atlas={atlas} view={view} />}
                {section === "notifications" && <Notifications atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "data" && <Data atlas={atlas} onSignOut={onSignOut} onSetup={onSetup} />}
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
  // Once tried, the sample follows the preset and scales as they move.
  const shape = JSON.stringify(c);
  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => atlas.test("sample", { type: "atlas.test", what: "sample", character: c }), 700);
    return () => clearTimeout(t);
  }, [shape]);
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
          <input
            maxLength={40}
            value={draft.assistant_name}
            onChange={(e) => edit({ assistant_name: e.target.value })}
            style={{ maxWidth: 220 }}
          />
          <span className="muted small">It answers to this name, out loud too.</span>
        </div>
        <label className="field">
          <span>What it calls you</span>
          <input maxLength={80} value={draft.owner_name} onChange={(e) => edit({ owner_name: e.target.value })} style={{ maxWidth: 220 }} />
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
            maxLength={2_000}
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
              <span className="faint">Press Try it to see how this character answers, before saving.</span>
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
            Try it
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
  const icloud = view.secrets.icloud;
  return (
    <>
      <Head title="Connections" sub="What Atlas can see, and where it can speak. Each one has its own live test." />
      <Row label="iCloud Calendar">
        <State
          on={!!icloud && !icloud.refused}
          bad={!!icloud?.refused}
          text={icloud ? (icloud.refused ? "Refused by Apple" : `Connected as ${icloud.username}`) : "Not connected"}
          what="Reads your calendars."
        />
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
      <Row label="Web search">
        <WebSearch atlas={atlas} draft={draft} edit={edit} view={view} />
      </Row>
      <Row label="Maps and weather">
        <Maps atlas={atlas} draft={draft} edit={edit} view={view} />
      </Row>
      <Row label="Webhooks">
        <State
          on={view.webhooks.length > 0}
          text={view.webhooks.length ? `${view.webhooks.length} ${view.webhooks.length === 1 ? "webhook" : "webhooks"}` : "None yet"}
          what="Lights, scenes, anything with a web address. Atlas asks before calling one."
        />
        <Webhooks atlas={atlas} view={view} />
      </Row>
      <Row label="Senses">
        <Senses atlas={atlas} view={view} />
      </Row>
      <Row label="MCP servers">
        <McpServers atlas={atlas} />
      </Row>
      <Row label="Google, Microsoft, email">
        <p className="muted small">Not yet. Atlas connects to Google and Microsoft calendars, and reads mail, in a later version.</p>
      </Row>
    </>
  );
}

/**
 * Which search Atlas uses (§9.1). Cloudflare's is built in and paid from AI
 * Gateway credits; the others have free allowances and take a key.
 */
function WebSearch({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const provider = draft.web.search;
  const p = PROVIDERS[provider];
  const keyName = `${provider}_api_key` as "tavily_api_key" | "brave_api_key" | "exa_api_key";
  const ready = !p.key || view.secrets[keyName];
  return (
    <>
      <State on={ready} text={ready ? p.name : `${p.name}: no key yet`} what="Searches the web when Atlas needs to know something." />
      <label className="field">
        <span>Search with</span>
        <select value={provider} onChange={(e) => edit({ web: { search: e.target.value as SearchProvider } })}>
          {(Object.keys(PROVIDERS) as SearchProvider[]).map((k) => (
            <option key={k} value={k}>
              {PROVIDERS[k].name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        {p.about} Private details (secrets, emails, phone numbers, saved addresses, where you are) never go into a search.
      </p>
      {p.key && (
        <SecretField
          label={`${p.name} key`}
          set={view.secrets[keyName]}
          onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: keyName, value: value?.trim() ?? null } })}
        />
      )}
      {view.settings.web.search === provider ? (
        <TestRow label="Test search" k="search" atlas={atlas} run={() => atlas.test("search", { type: "atlas.test", what: "search" })} />
      ) : (
        <p className="muted small">Save to test it.</p>
      )}
    </>
  );
}

/**
 * Skills (§9.3): what Atlas has learned to do, in the SKILL.md format. Each
 * one shows what it's for, how often it's used, whether its check passes,
 * and every version; you can edit it, bring an old version back, archive
 * it, or download it. A SKILL.md from another agent can be pasted in.
 */
function Skills({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.skills" });
  }, [atlas.voice.connected, s.rows.length]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; md: string } | null>(null);
  const skills = s.skills;
  const active = skills?.filter((k) => k.state === "active") ?? [];
  const archived = skills?.filter((k) => k.state === "archived") ?? [];
  const download = (name: string, md: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${name}.SKILL.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const row = (k: NonNullable<typeof skills>[number]) => (
    <div className="r" key={k.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="link" style={{ fontWeight: 500 }} onClick={() => setOpen(open === k.id ? null : k.id)}>
          {k.name}
        </button>
        {k.checked && <span className={`tag ${k.checked.ok ? "ok" : "ac"}`}>{k.checked.ok ? "✓ Check passes" : "× Check fails"}</span>}
        <span className="grow" />
        <span className="mono faint small">
          v{k.version} · {k.uses ? `used ${k.uses}×` : "not used yet"}
        </span>
      </div>
      <span className="muted small">{k.description}</span>
      {open === k.id && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
          <div className="panel">
            <Markdown text={k.body} />
          </div>
          {k.check && (
            <p className="small">
              <span className="lab">Check</span> <code className="mono">{k.check}</code>
            </p>
          )}
          {k.checked && !k.checked.ok && <pre className="code-block mono">{k.checked.output}</pre>}
          <div className="rows">
            {k.versions.map((v) => (
              <div className="r" key={v.n}>
                <span className="mono small" style={{ flex: "none" }}>
                  v{v.n}
                </span>
                <span className="small grow">{v.note}</span>
                <span className="lab faint">
                  {v.by === "owner" ? "You" : "Atlas"} · {shortDay(v.at)}
                </span>
                {v.n !== k.version && (
                  <button className="link small" onClick={() => atlas.send({ type: "atlas.skill.restore", id: k.id, n: v.n })}>
                    Bring back
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setEditing({ id: k.id, md: k.md })}>
              Edit
            </button>
            <button className="btn sm" onClick={() => download(k.name, k.md)}>
              Download SKILL.md
            </button>
            <button
              className="btn sm"
              onClick={() => atlas.send({ type: "atlas.skill.state", id: k.id, state: k.state === "active" ? "archived" : "active" })}
            >
              {k.state === "active" ? "Archive" : "Bring back"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
  return (
    <>
      <Head
        title="Skills"
        sub="What Atlas has learned to do, written down so it does it the same way next time. Atlas opens the right one before a task it covers, and improves it when it was wrong."
      />
      <Row label="Skills">
        {skills == null ? (
          <p className="lab">Looking</p>
        ) : active.length === 0 ? (
          <p className="muted small">
            None yet. After a task that took some working out and went the way you wanted, Atlas writes down how, and says "Learned a
            skill".
          </p>
        ) : (
          <div className="rows">{active.map(row)}</div>
        )}
        {archived.length > 0 && (
          <>
            <p className="lab" style={{ marginTop: 12 }}>
              Archived (unused for months; never deleted)
            </p>
            <div className="rows">{archived.map(row)}</div>
          </>
        )}
      </Row>
      <Row label={editing?.id ? "Edit" : "Add one"}>
        {editing ? (
          <form
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              atlas.send({ type: "atlas.skill.save", md: editing.md });
              setEditing(null);
            }}
          >
            <textarea
              className="mono"
              rows={16}
              spellCheck={false}
              value={editing.md}
              onChange={(e) => setEditing({ ...editing, md: e.target.value })}
            />
            <div className="row">
              <button className="btn primary" disabled={editing.md.trim().length < 20}>
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="muted small">Paste a SKILL.md from Claude Code, Codex, Hermes or OpenClaw; it works here unchanged.</p>
            <div className="row">
              <button
                className="btn"
                onClick={() =>
                  setEditing({
                    id: null,
                    md: "---\nname: my-skill\ndescription: What it's for and when to use it.\n---\n\n1. The first step.\n",
                  })
                }
              >
                Paste a SKILL.md
              </button>
            </div>
          </>
        )}
      </Row>
    </>
  );
}

/**
 * The vault (§15): logins, cards and keys by name, each tied to the sites it
 * fills on. Values go in here and never come back out: this page and Atlas
 * only see names, sites and which fields are set.
 */
function Vault({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const blank = {
    id: undefined as string | undefined,
    name: "",
    kind: "login" as VaultKind,
    sites: "",
    values: {} as Record<string, string>,
    totp: "",
  };
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const editing = form.id != null;
  const fields = Object.entries(FIELDS[form.kind]).filter(([k]) => k !== "code");
  const close = () => {
    setForm(blank);
    setOpen(false);
  };
  return (
    <>
      <Head
        title="Vault"
        sub="Logins, cards and keys, by name. Atlas fills them in at the last step and never sees them. Each one only fills on its own sites."
      />
      <Row label="Entries">
        {view.vault.length === 0 && <p className="muted small">Nothing yet. Add a login, and Atlas can sign in for you on that site.</p>}
        <div className="rows">
          {view.vault.map((e) => (
            <div className="r" key={e.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span style={{ fontWeight: 500 }}>{e.name}</span>
                <span className="tag">{e.kind}</span>
                <span className="mono faint small">{e.sites.join(", ")}</span>
                <span className="grow" />
                <button
                  className="link"
                  onClick={() => {
                    setForm({ id: e.id, name: e.name, kind: e.kind, sites: e.sites.join(", "), values: {}, totp: "" });
                    setOpen(true);
                  }}
                >
                  Edit
                </button>
                <button className="link" onClick={() => atlas.send({ type: "atlas.vault.remove", id: e.id })}>
                  Remove
                </button>
              </div>
              <span className="muted small">
                {[...e.fields.map((f) => FIELDS[e.kind][f] ?? f), ...(e.totp ? ["two-factor codes"] : [])].join(" · ")}
                {" · "}
                {e.uses ? `used ${e.uses} ${e.uses === 1 ? "time" : "times"}, last ${shortDay(e.last_used!)}` : "not used yet"}
              </span>
              {e.kind === "card" ? (
                <span className="faint small">A card asks every time.</span>
              ) : e.allowed.length ? (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="faint small">Fills without asking on</span>
                  {e.allowed.map((s) => (
                    <span key={s} className="tag">
                      {s}{" "}
                      <button className="link small" onClick={() => atlas.send({ type: "atlas.vault.revoke", id: e.id, site: s })}>
                        Ask again
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="faint small">The first use on each site asks you.</span>
              )}
            </div>
          ))}
        </div>
        {open ? (
          <form
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              atlas.send({
                type: "atlas.vault.save",
                ...(form.id ? { id: form.id } : {}),
                name: form.name,
                kind: form.kind,
                sites: form.sites
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                values: form.values,
                ...(form.kind === "login" && form.totp.trim() ? { totp: form.totp } : {}),
              });
              close();
            }}
          >
            <div className="row">
              <label className="field grow">
                <span>Name</span>
                <input
                  value={form.name}
                  maxLength={60}
                  placeholder="Chase login"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Kind</span>
                <select
                  value={form.kind}
                  disabled={editing}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as VaultKind, values: {} })}
                >
                  <option value="login">Login</option>
                  <option value="card">Card</option>
                  <option value="key">Key</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Fills only on (comma separated)</span>
              <input
                className="mono"
                value={form.sites}
                placeholder="chase.com"
                spellCheck={false}
                onChange={(e) => setForm({ ...form, sites: e.target.value })}
              />
            </label>
            {fields.map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input
                  type={k === "username" || k === "name" || k === "expiry" || k === "zip" ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={form.values[k] ?? ""}
                  placeholder={editing ? "Kept. Type a new one to change it." : ""}
                  onChange={(e) => setForm({ ...form, values: { ...form.values, [k]: e.target.value } })}
                />
              </label>
            ))}
            {form.kind === "login" && (
              <label className="field">
                <span>Two-factor seed (optional: the code the site shows under the QR code)</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.totp}
                  placeholder={editing ? "Kept if set. Paste a new one to change it." : "JBSWY3DPEHPK3PXP"}
                  onChange={(e) => setForm({ ...form, totp: e.target.value })}
                />
              </label>
            )}
            <div className="row">
              <button
                className="btn primary"
                disabled={!form.name.trim() || !form.sites.trim() || (!editing && !Object.values(form.values).some((v) => v.trim()))}
              >
                {editing ? "Save" : "Add"}
              </button>
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
            </div>
            <p className="muted small">Values are kept with your secrets. Neither this page nor Atlas can show them again.</p>
          </form>
        ) : (
          <div className="row">
            <button className="btn" onClick={() => setOpen(true)}>
              Add to the vault
            </button>
          </div>
        )}
      </Row>
    </>
  );
}

/** One connection's state: a tag, what it found, and what it's for. */
function State({ on, bad, text, what }: { on: boolean; bad?: boolean; text: string; what: string }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <span className={`tag ${on ? "ok" : bad ? "ac" : ""}`}>{on ? "✓ On" : bad ? "× Refused" : "Off"}</span>
      <span style={{ fontWeight: 500 }}>{text}</span>
      <span className="muted small">{what}</span>
    </div>
  );
}

/**
 * MCP servers (§9.2): services Atlas can use through their own tools. A
 * server with a sign-in waits for you to sign in; one that takes a token
 * gets it here. Tools a server marks as only reading run without asking;
 * the rest ask first, like a webhook.
 */
function McpServers({ atlas }: { atlas: Atlas }) {
  const servers = atlas.state.mcpServers;
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.mcp" });
  }, [atlas.voice.connected]);
  const blank = { name: "", url: "", token: "" };
  const [form, setForm] = useState(blank);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const ready = servers?.filter((s) => s.state === "ready").length ?? 0;
  const label = (state: string) =>
    state === "ready"
      ? "Connected"
      : state === "authenticating"
        ? "Waiting for you to sign in"
        : state === "failed"
          ? "Failed"
          : "Connecting";
  return (
    <>
      <State
        on={ready > 0}
        text={servers?.length ? `${ready} of ${servers.length} connected` : "None yet"}
        what="Other services' own tools. Atlas can also ask to add one when a task needs it."
      />
      <div className="rows">
        {(servers ?? []).map((s) => (
          <div className="r" key={s.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="link" style={{ fontWeight: 500 }} onClick={() => setOpen(open === s.id ? null : s.id)}>
                {s.name}
              </button>
              <span className={`tag ${s.state === "ready" ? "ok" : s.state === "failed" ? "ac" : ""}`}>{label(s.state)}</span>
              <span className="grow" />
              {s.auth_url && (
                <a className="btn primary" href={s.auth_url} target="_blank" rel="noopener noreferrer">
                  Sign in
                </a>
              )}
              <button className="link" onClick={() => atlas.send({ type: "atlas.mcp.remove", id: s.id })}>
                Remove
              </button>
            </div>
            <span className="mono faint small">
              {s.url} · {s.tools.length} {s.tools.length === 1 ? "tool" : "tools"}
            </span>
            {s.error && <p className="err small">{s.error}</p>}
            {open === s.id && (
              <div className="rows">
                {s.tools.map((t) => (
                  <div className="r" key={t.name} style={{ alignItems: "flex-start" }}>
                    <span className="grow small">
                      <span className="mono">{t.title ?? t.name}</span>
                      {t.description && (
                        <span className="muted" style={{ display: "block" }}>
                          {t.description}
                        </span>
                      )}
                    </span>
                    {t.page && <span className="tag">Has a page</span>}
                    <span className={`tag ${t.reads ? "ok" : ""}`}>{t.reads ? "Only reads" : "Asks first"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {adding ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            atlas.send({
              type: "atlas.mcp.add",
              name: form.name.trim(),
              url: form.url.trim(),
              ...(form.token.trim() ? { token: form.token.trim() } : {}),
            });
            setForm(blank);
            setAdding(false);
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={form.name} maxLength={60} placeholder="Linear" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Its MCP address</span>
            <input
              className="mono"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Token, if it takes one instead of a sign-in</span>
            <input
              className="mono"
              type="password"
              autoComplete="off"
              value={form.token}
              placeholder="Leave empty to sign in"
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </label>
          <div className="row">
            <button className="btn primary" disabled={!form.name.trim() || !/^https:\/\/./.test(form.url.trim())}>
              Add
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm(blank);
                setAdding(false);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="muted small">
            A server with a sign-in shows Sign in here once it's added. A token is kept with the server and never shown again.
          </p>
        </form>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}>
            Add a server
          </button>
        </div>
      )}
    </>
  );
}

function Webhooks({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const blank = { id: undefined as string | undefined, name: "", url: "", method: "POST" as "POST" | "GET", about: "" };
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const editing = form.id != null;
  return (
    <>
      <div className="rows">
        {view.webhooks.map((w) => (
          <div className="r" key={w.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span style={{ fontWeight: 500 }}>{w.name}</span>
              <span className="mono faint small">
                {w.method} · {w.host}
              </span>
              <span className="grow" />
              <button
                className="link"
                onClick={() => {
                  setForm({ id: w.id, name: w.name, url: "", method: w.method, about: w.about });
                  setOpen(true);
                }}
              >
                Edit
              </button>
              <button className="link" onClick={() => atlas.send({ type: "atlas.webhook.remove", id: w.id })}>
                Remove
              </button>
            </div>
            {w.about && <p className="muted small">{w.about}</p>}
            <TestRow
              label="Call it now"
              k={`webhook:${w.id}`}
              atlas={atlas}
              run={() => atlas.test(`webhook:${w.id}`, { type: "atlas.test", what: "webhook", id: w.id })}
            />
          </div>
        ))}
      </div>
      {open ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            atlas.send({ type: "atlas.webhook.save", ...form, url: form.url.trim() || undefined });
            setForm(blank);
            setOpen(false);
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={form.name} maxLength={60} placeholder="Lights off" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Address</span>
            <input
              className="mono"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={form.url}
              placeholder={editing ? "Kept. Paste a new one to change it." : "https://"}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
          <label className="field">
            <span>What it does, so Atlas knows when to use it</span>
            <input
              value={form.about}
              maxLength={300}
              placeholder="Turns off the living room lights"
              onChange={(e) => setForm({ ...form, about: e.target.value })}
            />
          </label>
          <div className="row">
            <select
              value={form.method}
              onChange={(e) => setForm({ ...form, method: e.target.value as "POST" | "GET" })}
              style={{ width: 90 }}
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
            <button className="btn primary" disabled={!form.name.trim() || (!editing && !/^https:\/\/./.test(form.url.trim()))}>
              {editing ? "Save" : "Add"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm(blank);
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="muted small">
            The address is kept with your secrets: Atlas and this page only ever show its host. A POST sends {"{ text, from, at }"} as JSON.
          </p>
        </form>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setOpen(true)}>
            Add a webhook
          </button>
        </div>
      )}
    </>
  );
}

// --- Permissions --------------------------------------------------------------------------------

const KIND_NAMES: Record<string, { name: string; example: string; rule: string }> = {
  look: { name: "Looking", example: "Your calendar, what Atlas knows, the web", rule: "Never asks" },
  change_own: { name: "Changing your own things", example: "Reminders, notes, records", rule: "Does it, tells you, offers Undo" },
  outside: { name: "Reaching outside", example: "Calling a webhook", rule: "Asks until you trust it" },
  irreversible: { name: "Can't be undone", example: "Deleting something for good", rule: "Always asks, hold to confirm" },
};

function Permissions({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  return (
    <>
      <Head title="Permissions" sub="The kind of action decides when Atlas asks. That's a rule in Atlas's code, not its judgment." />
      <Row label="When Atlas asks">
        <div className="rows">
          {Object.entries(view.permissions.kinds).map(([k, v]) => (
            <div className="r" key={k} style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <div className="grow" style={{ minWidth: 200 }}>
                <p style={{ fontWeight: 500 }}>{KIND_NAMES[k]?.name ?? k}</p>
                <p className="muted small">{KIND_NAMES[k]?.example}</p>
                <p className="faint small">{v.why}</p>
              </div>
              <span className={`tag ${v.asks === "never" ? "" : "ac"}`}>{KIND_NAMES[k]?.rule ?? v.asks}</span>
            </div>
          ))}
          <div className="r" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <p style={{ fontWeight: 500 }}>Money</p>
              <p className="muted small">When Atlas can spend, in a later version</p>
            </div>
            <span className="tag ac">Always asks, showing the amount</span>
          </div>
        </div>
      </Row>
      <Row label="Atlas doesn't ask for">
        <div className="rows">
          {view.permissions.trusted.map((t) => (
            <div className="r" key={t.key}>
              <span className="grow" style={{ fontWeight: 500 }}>
                {t.name}
              </span>
              <span className="faint small">Since {shortDay(t.since)}</span>
              <button className="link" onClick={() => atlas.send({ type: "atlas.trust.set", key: t.key, trusted: false })}>
                Ask again
              </button>
            </div>
          ))}
          {!view.permissions.trusted.length && (
            <p className="muted small">
              Nothing yet. After you've approved the same webhook five times as it was, Atlas offers to stop asking.
            </p>
          )}
        </div>
      </Row>
    </>
  );
}

/** What would make the server refuse a draft, in plain words, or null. Mirrors the limits in core's settings. */
function draftProblem(d: SettingsT): string | null {
  if (!d.assistant_name.trim()) return "Give Atlas a name before saving.";
  if (d.assistant_name.length > 40) return "Atlas's name can be at most 40 characters.";
  if (d.owner_name.length > 80) return "Your name can be at most 80 characters.";
  if (d.character.notes.length > 2_000) return "The notes can be at most 2,000 characters.";
  for (const role of ["main", "voice"] as const) {
    if (d.brains[role].some((b) => !b.model.trim())) return "Every brain in a chain needs a model name.";
  }
  return null;
}

// --- Notifications ----------------------------------------------------------------------------

const PUSH_NOTE: Record<PushState, string> = {
  on: "On. When Atlas isn't open in front of you, messages reach you here.",
  off: "Off on this device.",
  blocked: "Blocked in this browser. Allow notifications for this site in the browser's settings, then come back.",
  install:
    "On iPhone and iPad, notifications need Atlas on the Home Screen: tap Share, then Add to Home Screen, and open Atlas from there.",
  unsupported: "This browser can't take notifications.",
};

function Notifications({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const me = deviceId();
  const mine = view.push.devices.find((d) => d.id === me);
  const [browser, setBrowser] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setBrowser);
  }, [view.push.devices.length]);
  // Subscribed in the browser but forgotten by Atlas (it was removed, or the push service dropped it) reads as off.
  const state: PushState | null = browser === "on" && !mine ? "off" : browser;
  const quiet = draft.notifications.quiet;

  async function turnOn() {
    if (!view.push.public_key) return;
    setBusy(true);
    setError(null);
    const out = await subscribe(view.push.public_key);
    if ("error" in out) setError(out.error);
    else {
      atlas.send({
        type: "atlas.push.subscribe",
        device: me,
        name: deviceName(),
        origin: location.origin,
        subscription: out.sub as { endpoint: string; keys: { p256dh: string; auth: string } },
      });
    }
    setBrowser(await pushState());
    setBusy(false);
  }

  return (
    <>
      <Head
        title="Notifications"
        sub="When Atlas isn't open in front of you, each message reaches you once, on the device you used last."
      />
      <Row label="This device">
        <p className={state === "blocked" ? "err small" : "small"}>{state ? PUSH_NOTE[state] : "Checking."}</p>
        <div className="row">
          {state === "off" && (
            <button className="btn primary" disabled={busy || !view.push.public_key} onClick={() => void turnOn()}>
              {busy ? "Waiting for the browser" : "Turn on notifications here"}
            </button>
          )}
          {state === "on" && (
            <>
              <TestRow
                label="Send a test"
                k="push"
                atlas={atlas}
                run={() => atlas.test("push", { type: "atlas.test", what: "push", device: me })}
              />
              <button
                className="btn"
                onClick={() => {
                  void unsubscribe().then(async () => setBrowser(await pushState()));
                  atlas.send({ type: "atlas.push.remove", device: me });
                }}
              >
                Turn off here
              </button>
            </>
          )}
        </div>
        {error && <p className="err small">{error}</p>}
      </Row>
      <Row label="Devices">
        <div className="rows">
          {view.push.devices.map((d) => (
            <div className="r" key={d.id}>
              <span className="grow" style={{ fontWeight: 500 }}>
                {d.name}
                {d.id === me && <span className="muted"> · this one</span>}
              </span>
              <span className="faint small">Used {shortDay(d.last_seen)}</span>
              <button className="link" onClick={() => atlas.send({ type: "atlas.push.remove", device: d.id })}>
                Remove
              </button>
            </div>
          ))}
          {!view.push.devices.length && <p className="muted small">No device takes notifications yet.</p>}
        </div>
      </Row>
      <Row label="When Atlas isn't open">
        <label className="check">
          <input
            type="checkbox"
            checked={draft.notifications.push}
            onChange={(e) => edit({ notifications: { ...draft.notifications, push: e.target.checked } })}
          />
          Send a notification to the device I used last
        </label>
        <p className="muted small">With Atlas open in front of you, or in a voice call, messages just arrive there.</p>
      </Row>
      <Row label="Speaking up">
        <Speaking draft={draft} edit={edit} />
      </Row>
      <Row label="Quiet hours">
        <label className="check">
          <input
            type="checkbox"
            checked={quiet.on}
            onChange={(e) => edit({ notifications: { ...draft.notifications, quiet: { ...quiet, on: e.target.checked } } })}
          />
          Hold notifications that can wait
        </label>
        <div className="row">
          <label className="field" style={{ width: 130 }}>
            <span>From</span>
            <input
              type="time"
              value={quiet.from}
              disabled={!quiet.on}
              onChange={(e) =>
                e.target.value && edit({ notifications: { ...draft.notifications, quiet: { ...quiet, from: e.target.value } } })
              }
            />
          </label>
          <label className="field" style={{ width: 130 }}>
            <span>Until</span>
            <input
              type="time"
              value={quiet.to}
              disabled={!quiet.on}
              onChange={(e) =>
                e.target.value && edit({ notifications: { ...draft.notifications, quiet: { ...quiet, to: e.target.value } } })
              }
            />
          </label>
        </div>
        <p className="muted small">
          Reminders you set and answers to what you asked still come right away. Everything else waits, then arrives as one notification
          when quiet hours end. Times are in {view.settings.timezone || "UTC"}.
        </p>
      </Row>
      <Row label="Focus">
        {view.focus ? (
          <>
            <p className="small">
              Focusing{view.focus.about ? ` on ${view.focus.about}` : ""} until {shortDay(view.focus.until)}. Notifications that can wait
              are held until then.
            </p>
            <div className="row">
              <button className="btn" onClick={() => atlas.send({ type: "atlas.focus", minutes: 0 })}>
                End focus
              </button>
            </div>
          </>
        ) : (
          <div className="row">
            {[30, 60, 120, 240].map((m) => (
              <button key={m} className="btn sm" onClick={() => atlas.send({ type: "atlas.focus", minutes: m })}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Like quiet hours, for a while. You can also say "focus for 45 minutes" to Atlas.</p>
      </Row>
      <Row label="Interruption budget">
        <div className="row">
          <select
            value={draft.notifications.budget}
            style={{ width: 200 }}
            onChange={(e) => edit({ notifications: { ...draft.notifications, budget: Number(e.target.value) } })}
          >
            {[3, 5, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n} a day
              </option>
            ))}
            <option value={0}>No limit</option>
          </select>
          <span className="faint small">{view.push.today} used today</span>
        </div>
        <p className="muted small">
          Notifications for things that could wait, each day. Past it, they wait in the app. Reminders you set and answers to what you asked
          don't count.
        </p>
      </Row>
      <Row label="By urgency">
        <div className="rows">
          <div className="r small">
            <span style={{ width: 90, flex: "none", fontWeight: 500 }}>Now</span>
            <span className="grow muted">
              Reminders you set, answers to what you asked, your routines on their times. A notification at once, through quiet hours and
              focus.
            </span>
          </div>
          <div className="r small">
            <span style={{ width: 90, flex: "none", fontWeight: 500 }}>Can wait</span>
            <span className="grow muted">
              Job reports, watches, failures, approvals. A notification unless quiet hours or focus hold it, or the day's budget is used.
            </span>
          </div>
          <div className="r small">
            <span style={{ width: 90, flex: "none", fontWeight: 500 }}>Never</span>
            <span className="grow muted">Automations that report only to History, and Inbox items. They wait for you to look.</span>
          </div>
        </div>
        <p className="muted small">
          Either way, one channel: the app when it's open in front of you, a call if you're in one, or else one device.
        </p>
      </Row>
    </>
  );
}

// --- Devices ----------------------------------------------------------------------------------

function Devices({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <>
      <Head title="Devices" sub="Where you are, from your phone, and the passkeys that sign in to Atlas." />
      <Row label="Location">
        <Location atlas={atlas} view={view} />
      </Row>
      <Row label="Paired devices">
        <PairedDevices atlas={atlas} view={view} />
      </Row>
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
              {removing === p.id ? (
                <span className="row" style={{ gap: 8 }}>
                  <span className="small">{view.passkeys.length === 1 ? "Your last passkey. Remove it?" : "Remove it?"}</span>
                  <button
                    className="link err"
                    onClick={() => {
                      atlas.send({ type: "atlas.passkey.remove", id: p.id });
                      setRemoving(null);
                    }}
                  >
                    Remove
                  </button>
                  <button className="link" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button className="link" onClick={() => setRemoving(p.id)}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {!view.passkeys.length && <p className="muted small">No passkeys yet. Until you add one, you sign in with your setup code.</p>}
        </div>
        <AddPasskey />
        <p className="muted small">Lost every passkey? Your setup code still signs you in.</p>
      </Row>
    </>
  );
}

/**
 * Paired devices (§16.3): each one online or not, its capabilities with a
 * switch (sensitive ones start off), and Remove, which unpairs it at once.
 * Pairing starts on the device, which shows a QR code and a short code.
 */
function PairedDevices({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <>
      {view.nodes.map((n) => (
        <div key={n.id} className="device-card">
          <div className="row" style={{ gap: 10 }}>
            <span className={`tag ${n.online ? "ok" : ""}`}>{n.online ? "● Online" : "Offline"}</span>
            <span style={{ fontWeight: 500 }}>{n.name}</span>
            <span className="muted small">
              {n.platform ?? n.kind}
              {!n.online && n.last_seen ? ` · last seen ${shortDay(n.last_seen)}` : ""}
            </span>
            <span className="grow" />
            {removing === n.id ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="small">Unpair it?</span>
                <button
                  className="link err"
                  onClick={() => {
                    atlas.send({ type: "atlas.node.remove", id: n.id });
                    setRemoving(null);
                  }}
                >
                  Remove
                </button>
                <button className="link" onClick={() => setRemoving(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="link" onClick={() => setRemoving(n.id)}>
                Remove
              </button>
            )}
          </div>
          {n.capabilities.length ? (
            <div className="rows" style={{ marginTop: 6 }}>
              {n.capabilities.map((c) => (
                <label className="r check" key={c.name} style={{ alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    checked={c.on}
                    onChange={(e) => atlas.send({ type: "atlas.node.allow", id: n.id, capability: c.name, on: e.target.checked })}
                  />
                  <span className="grow">
                    <span style={{ fontWeight: 500 }}>{c.name.replace(/_/g, " ")}</span>
                    {c.sensitive && (
                      <span className="tag ac" style={{ marginLeft: 8 }}>
                        Sensitive
                      </span>
                    )}
                    {c.acts && (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        Asks first
                      </span>
                    )}
                    <span className="muted small" style={{ display: "block" }}>
                      {c.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted small">It says what it can do when it first connects.</p>
          )}
        </div>
      ))}
      {!view.nodes.length && (
        <p className="muted small">
          No devices yet. Install the Atlas desktop app on your Mac (from the repo's releases), and it shows a QR code to scan with your
          phone, or a code to type here.
        </p>
      )}
      <div className="row">
        <input
          value={code}
          placeholder="Code from the device, like K7Q2-M9XA"
          onChange={(e) => setCode(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <a
          className="btn"
          href={`#/pair/${encodeURIComponent(code.trim())}`}
          aria-disabled={!code.trim()}
          onClick={(e) => !code.trim() && e.preventDefault()}
        >
          Pair
        </a>
      </div>
    </>
  );
}

/** Pairing a device (§16.3): what's asking, and a yes or no. The device shows the code; this is where it lands when scanned. */
export function Pair({ atlas, code }: { atlas: Atlas; code: string }) {
  const s = atlas.state;
  const [said, setSaid] = useState<boolean | null>(null);
  useEffect(() => {
    if (atlas.voice.connected && code) atlas.send({ type: "atlas.node.pairing", code });
  }, [code, atlas.voice.connected]);
  const asked = code in s.pairing ? { pairing: s.pairing[code] ?? null } : null;
  const done = said == null ? null : { yes: said, name: code in s.paired ? s.paired[code]! : null };
  const p = asked?.pairing;
  return (
    <Stage label="Pair a device" meta="Atlas · M4">
      <Sheet>
        <div className="sheet-in" style={{ maxWidth: 560 }}>
          <div className="sheet-title">
            <h1 className="disp">
              {done ? (done.yes ? (done.name ? `Paired ${done.name}` : "Pairing") : "Not paired") : "Pair this device?"}
            </h1>
          </div>
          {done ? (
            <p>
              {done.yes && done.name
                ? `${done.name} connects in a moment. Its tools are in Settings → Devices, with the sensitive ones off until you turn them on.`
                : "Nothing was paired."}{" "}
              <a className="link" href="#/settings/devices">
                Settings → Devices
              </a>
            </p>
          ) : !asked ? (
            <p className="muted">{s.view ? "Looking up the code." : "Connecting to Atlas."}</p>
          ) : !p ? (
            <p className="err">
              That code isn't waiting to pair: it may be mistyped, or it ran out (codes last ten minutes). Start again on the device.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 15, marginBottom: 8 }}>
                <b>{p.name}</b> ({p.platform ?? p.kind}) wants to connect to your Atlas with code{" "}
                <span className="mono">{code.toUpperCase()}</span>.
              </p>
              <p className="muted small" style={{ marginBottom: 16 }}>
                Pair only a device you're setting up yourself, right now. Once paired, Atlas can use what it offers while it's online;
                anything that acts on it asks you first, and sensitive things start off. You can remove it any time.
              </p>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => {
                    setSaid(true);
                    atlas.send({ type: "atlas.node.pair", code, yes: true });
                  }}
                >
                  Pair
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setSaid(false);
                    atlas.send({ type: "atlas.node.pair", code, yes: false });
                  }}
                >
                  Not now
                </button>
              </div>
            </>
          )}
        </div>
      </Sheet>
    </Stage>
  );
}

/**
 * Speaking up (§10.3): whether Atlas tells you things on its own, the looks
 * it takes at set moments, and, in your own words, what it should always
 * bring up and what never (it keeps both lists itself when you say stop,
 * or ask why it didn't tell you, and you can change them here).
 */
function Speaking({ draft, edit }: { draft: SettingsT; edit: Edit }) {
  const sp = draft.speaking;
  const set = (patch: Partial<SettingsT["speaking"]>) => edit({ speaking: { ...sp, ...patch } });
  const flag = (k: "noticing" | "leave", label: string) => (
    <label className="check">
      <input type="checkbox" checked={sp[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
  const moment = (k: "morning" | "evening", label: string) => (
    <div className="row">
      <label className="check" style={{ minWidth: 200 }}>
        <input type="checkbox" checked={sp[k].on} onChange={(e) => set({ [k]: { ...sp[k], on: e.target.checked } })} />
        {label}
      </label>
      <label className="field" style={{ width: 130 }}>
        <input
          type="time"
          aria-label={`${label}: time`}
          value={sp[k].at}
          disabled={!sp[k].on}
          onChange={(e) => e.target.value && set({ [k]: { ...sp[k], at: e.target.value } })}
        />
      </label>
    </div>
  );
  return (
    <>
      {flag(
        "noticing",
        "What Atlas notices: where you are and are heading, changes on your calendar, traffic, the weather, your devices, your webhooks",
      )}
      {flag("leave", "When to leave for events with a place, from the travel time")}
      {moment("morning", "A look at the start of the day")}
      {moment("evening", "A look in the evening")}
      <Words
        label="Always bring up"
        empty={'Nothing yet. Asking "why didn\'t you tell me?" can add what you meant here.'}
        placeholder="Like: anything from my landlord"
        list={sp.tell_about}
        set={(tell_about) => set({ tell_about })}
      />
      <Words
        label="Don't bring up"
        empty={'Nothing yet. Saying "stop" to a nudge adds what you meant here.'}
        placeholder="Like: the weather unless it's severe"
        list={sp.quiet_about}
        set={(quiet_about) => set({ quiet_about })}
      />
      <p className="muted small">
        Atlas speaks up when it would help, and stays quiet otherwise; History shows what it decided each time and why, and "show me what
        you noticed" puts today's on the stage. These wait for quiet hours and count against the day's interruptions.
      </p>
    </>
  );
}

/** A list of the owner's own words, with a × on each and a field to add one. */
function Words(o: { label: string; empty: string; placeholder: string; list: string[]; set: (list: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const add = () => {
    const t = adding.trim();
    if (t && !o.list.some((q) => q.toLowerCase() === t.toLowerCase())) o.set([...o.list, t]);
    setAdding("");
  };
  return (
    <>
      <p className="small" style={{ marginTop: 12 }}>
        {o.label}
      </p>
      {o.list.length ? (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {o.list.map((q) => (
            <button key={q} className="chip" title="Take this off the list" onClick={() => o.set(o.list.filter((x) => x !== q))}>
              {q} ×
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small">{o.empty}</p>
      )}
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <input
            aria-label={o.label}
            placeholder={o.placeholder}
            value={adding}
            maxLength={120}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </label>
        <button className="btn sm" onClick={add} disabled={!adding.trim()}>
          Add
        </button>
      </div>
    </>
  );
}

const SOURCE_NAMES: Record<string, string> = {
  location: "Phone (OwnTracks)",
  device: "Paired devices",
  calendar: "Calendar",
  situation: "Trip and weather",
  webhook: "Webhook sources",
};

/**
 * Senses (§10.4): every source the intake has heard from, with its state,
 * and webhook sources: any service that can post (GitHub, Linear, a home
 * server) gets its own address with its own key, shown once.
 */
function Senses({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const [name, setName] = useState("");
  const made = atlas.state.senseHook;
  const now = Date.now();
  const ago = (at: number) => (now - at < 60_000 ? "just now" : `${shortDay(at)}, ${clock(at)}`);
  return (
    <>
      <State
        on={view.senses.sources.length > 0}
        text={view.senses.sources.length ? `${view.senses.sources.length} sources` : "Nothing yet"}
        what="Everything Atlas takes in comes through here and is weighed: now, later, or not at all."
      />
      {view.senses.sources.map((s) => {
        const bad = s.error && (!s.ok_at || (s.error_at ?? 0) > s.ok_at);
        return (
          <p className="small" key={s.source}>
            <b>{SOURCE_NAMES[s.source] ?? s.source.replace(/^webhook:/, "")}</b>{" "}
            <span className={bad ? "" : "muted"} style={bad ? { color: "var(--bad)" } : undefined}>
              {bad
                ? `${s.error} (${ago(s.error_at!)})`
                : s.last
                  ? `Last: ${s.last.what} (${ago(s.last.at)})`
                  : s.ok_at
                    ? `Working (${ago(s.ok_at)})`
                    : ""}
            </span>
          </p>
        );
      })}
      <p className="small" style={{ marginTop: 12 }}>
        Webhook sources
      </p>
      {view.senses.hooks.map((h) => (
        <div className="row" key={h.id}>
          <span style={{ fontWeight: 500 }}>{h.name}</span>
          <span className="muted small">
            {h.last_at ? `last post ${ago(h.last_at)}` : "no posts yet"}
            {h.refused_at ? ` · refused one ${ago(h.refused_at)}` : ""}
          </span>
          <span className="grow" />
          <button className="btn sm" onClick={() => atlas.send({ type: "atlas.sense.hook.remove", id: h.id })}>
            Remove
          </button>
        </div>
      ))}
      {made && view.senses.hooks.some((h) => h.id === made.id) && (
        <div className="cell" style={{ marginTop: 8 }}>
          <p className="small">
            <b>{made.name}</b>'s address, shown once. Paste it where the service asks for a webhook or payload URL (for GitHub, content type
            application/json). Anyone with it can post to Atlas, so keep it private.
          </p>
          <code className="small" style={{ wordBreak: "break-all", userSelect: "all" }}>
            {made.url}
          </code>
        </div>
      )}
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <input
            aria-label="Name of the service"
            placeholder="Like: GitHub, Linear, Home server"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          className="btn sm"
          disabled={!name.trim()}
          onClick={() => {
            atlas.send({ type: "atlas.sense.hook.add", name: name.trim() });
            setName("");
          }}
        >
          Add source
        </button>
      </div>
    </>
  );
}

/**
 * Location (§10.1): OwnTracks on the phone posts to Atlas with its own user
 * and password. Set up makes them (replacing any before) and a link that
 * fills them into OwnTracks in one tap, with a QR code for the phone's camera.
 * The switch stops it at once.
 */
function Location({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const l = view.location;
  const on = view.settings.location.on;
  const setup = atlas.state.ownTracks;
  const [asking, setAsking] = useState(false);
  const fix = l.fix;
  const where = l.place
    ? `At ${l.place.name} since ${clock(l.place.since)}`
    : l.near
      ? `${(l.near.m / 1000).toFixed(1)} km from ${l.near.name}`
      : fix
        ? "Not at a saved place"
        : null;
  return (
    <>
      <State
        on={on && l.set_up}
        text={!on ? "Off" : !l.set_up ? "Not set up" : fix ? `Last fix ${shortDay(fix.at)}, ${clock(fix.at)}` : "Waiting for OwnTracks"}
        what="OwnTracks on your phone tells Atlas where you are."
      />
      {on && fix && (
        <p className="small">
          {where}
          <span className="muted">
            {" "}
            · accurate to {fix.acc} m{fix.batt != null ? ` · phone ${fix.batt}%${fix.charging ? ", charging" : ""}` : ""}
          </span>
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => atlas.send({ type: "atlas.settings.update", patch: { location: { on: e.target.checked } } })}
        />
        Take in my location. Off drops what the phone sends, and Atlas says it doesn't know where you are.
      </label>
      <p className="muted small">
        {l.pins} saved {l.pins === 1 ? "place has" : "places have"} a pin, sent to OwnTracks as regions so arriving and leaving are noticed.
        Say "this is my gym" somewhere, or "pin the dentist at 12 Main St", to add one.
      </p>
      {l.refused && (
        <p className="err small">
          A post with the wrong password came {shortDay(l.refused.at)}. If that was your phone, set OwnTracks up again.
        </p>
      )}
      {setup ? (
        <div className="row" style={{ alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          <QrCode text={setup.link} size={240} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, maxWidth: 420 }}>
            <p className="small">
              Install OwnTracks on your phone, then scan this with the camera or tap Open in OwnTracks on the phone. It fills in Atlas's
              address, a user and a password made for it alone, and your places.
            </p>
            <a className="btn primary" href={setup.link} style={{ textDecoration: "none", alignSelf: "flex-start" }}>
              Open in OwnTracks
            </a>
            <p className="faint small mono" style={{ wordBreak: "break-all" }}>
              {setup.url} · user {setup.user} · password {setup.password}
            </p>
            <p className="muted small">
              This is the only time the password is shown. Setting up again makes a new one, and the old one stops working.
            </p>
          </div>
        </div>
      ) : asking ? (
        <div className="row">
          <span className="small">
            {l.set_up ? "This makes a new password; the phone stops reporting until it has it." : "Make OwnTracks' user and password?"}
          </span>
          <button
            className="btn primary"
            onClick={() => {
              setAsking(false);
              atlas.send({ type: "atlas.location.setup" });
            }}
          >
            Set up
          </button>
          <button className="link" onClick={() => setAsking(false)}>
            Not now
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setAsking(true)}>
            {l.set_up ? "Set up OwnTracks again" : "Set up OwnTracks"}
          </button>
        </div>
      )}
    </>
  );
}

/** Maps and weather (§19.1): OpenStreetMap's free services, or Mapbox by key; units; a live test. */
function Maps({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const provider = draft.maps.provider;
  const ready = provider === "osm" || view.secrets.mapbox_token;
  return (
    <>
      <State
        on={ready}
        text={ready ? MAPS[provider].name : "Mapbox: no token yet"}
        what="Routes, travel times, and places near you or on your way."
      />
      <label className="field">
        <span>Maps from</span>
        <select value={provider} onChange={(e) => edit({ maps: { provider: e.target.value as MapsProvider } })}>
          <option value="osm">OpenStreetMap (free, nothing to set up)</option>
          <option value="mapbox">Mapbox (free tier, needs a token)</option>
        </select>
      </label>
      <p className="muted small">
        {provider === "osm"
          ? "OpenStreetMap's free, volunteer-run services: travel times are typical, without live traffic, and opening hours are often missing. Atlas asks them little and caches what it can."
          : "Mapbox adds live traffic to travel times and better store search. Pins for your places still come from OpenStreetMap, since Mapbox's free answers can't be kept."}{" "}
        Where you are and your saved addresses go only to the maps service; the weather (Open-Meteo, free) gets a rough area.
      </p>
      {provider === "mapbox" && (
        <SecretField
          label="Mapbox token"
          set={view.secrets.mapbox_token}
          onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "mapbox_token", value: value?.trim() ?? null } })}
        />
      )}
      <label className="field">
        <span>Units</span>
        <select value={draft.units} onChange={(e) => edit({ units: e.target.value as SettingsT["units"] })}>
          <option value="auto">From the time zone</option>
          <option value="us">°F and miles</option>
          <option value="metric">°C and kilometres</option>
        </select>
      </label>
      {view.settings.maps.provider === provider ? (
        <TestRow
          label="Test maps and weather"
          k="maps"
          atlas={atlas}
          run={() => atlas.test("maps", { type: "atlas.test", what: "maps" })}
        />
      ) : (
        <p className="muted small">Save to test it.</p>
      )}
    </>
  );
}

/**
 * Adds a passkey on this device. If Atlas asks for the setup code first
 * (a passkey exists and this sign-in isn't recent), it asks for it here.
 */
export function AddPasskey() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [askCode, setAskCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    const out = await addPasskey(deviceName(), askCode ? code : undefined);
    setBusy(false);
    if (out?.needsCode) setAskCode(true);
    else if (!out) {
      setAskCode(false);
      setCode("");
    }
    setMsg(out ? { ok: false, text: out.error } : { ok: true, text: "Added. This device can sign in with its passkey now." });
  }
  if (!passkeysSupported()) return <p className="muted small">This browser can't make passkeys. Your setup code still signs you in.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
      {askCode && (
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Setup code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && code && void add()}
        />
      )}
      <div className="row">
        <button className="btn" disabled={busy || (askCode && !code)} onClick={() => void add()}>
          {busy ? "Waiting for your device" : "Add a passkey on this device"}
        </button>
        {msg && <span className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function Data({ atlas, onSignOut, onSetup }: { atlas: Atlas; onSignOut: () => void; onSetup: () => void }) {
  const [ended, setEnded] = useState(false);
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
          <button
            className="btn"
            onClick={() => {
              atlas.send({ type: "atlas.sessions.end" });
              setEnded(true);
              setTimeout(onSignOut, 600);
            }}
          >
            Sign out everywhere
          </button>
        </div>
        <p className="muted small">{ended ? "Every device is signed out." : "Ends every sign-in, on every device, including this one."}</p>
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
        <p className="err small">{connected.refused.note} Until then, Atlas answers from its copy of your calendar. Test tries once now.</p>
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
        const key = `brain:${role}:${b.provider}:${b.model}`;
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
        <button className="link" onClick={() => onChange([...chain, { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" }])}>
          Add a fallback
        </button>
      )}
    </div>
  );
}
