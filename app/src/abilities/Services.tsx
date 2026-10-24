// Abilities → Services (§17, docs/ui §8): a card per service, whatever is
// underneath (an extension, an MCP server, something built in). A card opens
// in place: what Atlas hears from it, what it can do there, its key, what it
// can reach, what it costs, its last error in the service's own words, and
// Off and Remove. Until the catalog arrives (stage 5), "More services" are
// the bundled extensions not installed yet, and Custom adds an MCP server.

import { useEffect, useState } from "react";
import type { ExtensionView, McpServerView, SettingsView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { SecretField, TestRow } from "../settings/parts";
import { useDetail } from "../theme";
import { ago, dayTime, Icon, Logo, pressable, QrCode, StateDot, Toggle, useNow } from "../ui";
import { CHIPS, extState, GIVES, type Service, services } from "./model";

export function Services({
  atlas,
  open,
  go,
  note,
}: {
  atlas: Atlas;
  open: string | null;
  go: (d: string) => void;
  note: { ok: boolean; text: string } | null;
}) {
  const view = atlas.state.view!;
  const [chip, setChip] = useState("all");
  const [q, setQ] = useState("");
  const all = services(view, atlas.state.mcpServers);
  const shown = open ? all.find((s) => s.key === open) : null;
  if (shown) return <ServiceOpen atlas={atlas} s={shown} onBack={() => go("services")} />;

  const match = (s: Service) =>
    (chip === "all" || (chip === "on" ? s.installed : s.groups.includes(chip))) &&
    (!q.trim() || `${s.name} ${s.about} ${s.does}`.toLowerCase().includes(q.trim().toLowerCase()));
  const on = all.filter((s) => s.installed && match(s));
  const more = all.filter((s) => !s.installed && match(s));
  const count = (id: string) => all.filter((s) => (id === "all" ? true : id === "on" ? s.installed : s.groups.includes(id))).length;
  return (
    <div className="sheet-in">
      {note && (
        <p className={`small ${note.ok ? "ok" : "err"}`} style={{ marginBottom: 10 }}>
          {note.text}
        </p>
      )}
      <div className="row" style={{ marginBottom: 14 }}>
        {CHIPS.map(([id, name]) => (
          <button key={id} className={`fchip ${chip === id ? "on" : ""}`} onClick={() => setChip(id)}>
            {name}
            <span className="mono aside">{count(id)}</span>
          </button>
        ))}
        <span className="grow" />
        <label className="find">
          <Icon name="search" size={13} />
          <input value={q} placeholder="Find a service" onChange={(e) => setQ(e.target.value)} aria-label="Find a service" />
        </label>
      </div>
      <span className="lab">On · {on.length}</span>
      <div className="svc-grid">
        {on.map((s) => (
          <button key={s.key} className={`card2 svc ${s.state === "needs" ? "needs" : ""}`} onClick={() => go(`services:${s.key}`)}>
            <span className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
              <SvcLogo s={s} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }} className="grow">
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span className="aside clip">{s.about}</span>
              </span>
            </span>
            <span className="small muted clip" style={{ width: "100%" }}>
              {s.does}
            </span>
            <span className="row" style={{ marginTop: "auto", width: "100%", flexWrap: "nowrap" }}>
              <StateDot state={s.state} />
              <span className={`small clip grow ${s.state === "needs" ? "ac" : "muted"}`}>{s.said}</span>
              <span className="mono aside">{s.cost}</span>
            </span>
          </button>
        ))}
        {!on.length && <p className="aside">Nothing here yet.</p>}
      </div>
      <span className="lab" style={{ display: "block", marginTop: 18 }}>
        More services · {more.length}
      </span>
      {/* TODO(stage 5): the catalog from the index (Slack, Stripe, Google, Outlook and the rest) joins these, one card each. */}
      <div className="svc-grid">
        {more.map((s) => (
          <div key={s.key} className="card2 dim svc small-card" {...pressable(() => go(`services:${s.key}`))}>
            <span className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
              <SvcLogo s={s} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }} className="grow">
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span className="aside clip">{s.about}</span>
              </span>
            </span>
            <span className="row" style={{ width: "100%", flexWrap: "nowrap" }}>
              <span className="aside clip grow">
                {s.ext?.costs ? "Costs while it's used" : s.ext?.secrets.some((x) => !x.optional) ? "By key" : "Free"}
              </span>
              <button
                className="btn s"
                onClick={(e) => {
                  e.stopPropagation();
                  go(`services:${s.key}`);
                }}
              >
                {s.ext ? "Set up" : "Open"}
              </button>
            </span>
          </div>
        ))}
        <Custom atlas={atlas} />
      </div>
    </div>
  );
}

function SvcLogo({ s, size = 34 }: { s: Service; size?: number }) {
  if (s.builtin === "webhooks")
    return (
      <span className="logo" style={{ width: size, height: size, borderRadius: 8 }}>
        <Icon name="globe" size={Math.round(size * 0.5)} />
      </span>
    );
  return <Logo of={s.logo} name={s.name} size={size} />;
}

/** Custom: any MCP server by its address. Extensions from a link come with the catalog (stage 5). */
function Custom({ atlas }: { atlas: Atlas }) {
  const blank = { name: "", url: "", token: "" };
  const [form, setForm] = useState(blank);
  const [adding, setAdding] = useState(false);
  if (!adding)
    return (
      <div className="card2 dash svc small-card">
        <span className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
          <span className="logo" style={{ width: 34, height: 34, borderRadius: 8 }}>
            <Icon name="plus" size={14} />
          </span>
          <span style={{ display: "flex", flexDirection: "column" }} className="grow">
            <span style={{ fontWeight: 600 }}>Custom</span>
            <span className="aside">Any MCP server</span>
          </span>
        </span>
        <span className="row" style={{ width: "100%" }}>
          <span className="aside grow">By its address</span>
          <button className="btn s" onClick={() => setAdding(true)}>
            Add
          </button>
        </span>
      </div>
    );
  return (
    <form
      className="card2 svc custom-form"
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
      <input
        value={form.name}
        maxLength={60}
        placeholder="Its name, like Linear"
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <input
        className="mono"
        type="url"
        autoComplete="off"
        spellCheck={false}
        value={form.url}
        placeholder="https://mcp.example.com/mcp"
        onChange={(e) => setForm({ ...form, url: e.target.value })}
      />
      <input
        className="mono"
        type="password"
        autoComplete="off"
        value={form.token}
        placeholder="A token, if it takes one instead of a sign-in"
        onChange={(e) => setForm({ ...form, token: e.target.value })}
      />
      <div className="row">
        <button className="btnp s" disabled={!form.name.trim() || !/^https:\/\/./.test(form.url.trim())}>
          Add
        </button>
        <button type="button" className="btn s" onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- a service, opened in place --------------------------------------------------------------

function ServiceOpen({ atlas, s, onBack }: { atlas: Atlas; s: Service; onBack: () => void }) {
  const { at } = useDetail();
  const [more, setMore] = useState(false);
  const dev = more || at("developer");
  const view = atlas.state.view!;
  const e = s.ext;
  return (
    <div className="sheet-in rise">
      <button className="back" onClick={onBack}>
        <Icon name="back" size={14} /> Services
      </button>
      <div className="svc-open">
        <div className="svc-left">
          <div className="row" style={{ flexWrap: "nowrap", gap: 12 }}>
            <SvcLogo s={s} size={48} />
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span className="disp" style={{ fontSize: 22 }}>
                {s.name}
              </span>
              <span className="muted">{s.about}</span>
            </span>
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <StateDot state={s.state} />
            <span className="grow">{s.said}</span>
            {e && e.state !== "available" && e.state !== "draft" && (
              <Toggle
                on={e.state === "on"}
                label={`${s.name} on`}
                onChange={(on) => atlas.send({ type: "atlas.ext.state", id: e.id, on })}
              />
            )}
          </div>
          {e && <Connection atlas={atlas} e={e} dev={dev} />}
          {s.mcp && <McpConnection atlas={atlas} m={s.mcp} />}
          {s.builtin === "email" && <AtlasEmail atlas={atlas} view={view} />}
          {(e || s.builtin === "search") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontWeight: 600 }}>
                {e?.costs ? "What it costs" : s.builtin === "search" ? "What it costs" : "Costs nothing"}
              </span>
              <span className="muted small">
                {e
                  ? (e.costs ?? "Nothing beyond the service's own free plan.")
                  : "Paid from AI Gateway credits, about $0.25 per 1,000 searches."}
              </span>
            </div>
          )}
          {e && (dev || e.state === "available" || e.state === "draft") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="lab">Can reach</span>
              <span className="row" style={{ gap: 6 }}>
                {e.hosts.length ? (
                  e.hosts.map((h) => (
                    <span key={h} className="tag mono">
                      {h}
                    </span>
                  ))
                ) : (
                  <span className="aside">Nothing outside Atlas.</span>
                )}
              </span>
              <span className="mono aside">
                {e.id} · v{e.version} · {e.source === "bundled" ? "ships with Atlas" : e.source === "atlas" ? "written by Atlas" : "yours"}
              </span>
              {e.credit && <span className="aside">{e.credit}</span>}
            </div>
          )}
          <div className="row" style={{ paddingTop: 4 }}>
            {e && (e.state === "available" || e.state === "draft") && (
              <button className="btnp s" onClick={() => atlas.send({ type: "atlas.ext.install", id: e.id })}>
                {e.state === "draft" ? "Install it" : "Set it up"}
              </button>
            )}
            {e && e.state !== "available" && e.state !== "draft" && (
              <button className="btn s" onClick={() => atlas.send({ type: "atlas.ext.state", id: e.id, on: e.state !== "on" })}>
                {e.state === "on" ? "Turn off" : "Turn on"}
              </button>
            )}
            {e && e.state !== "available" && (
              <button
                className="btn s"
                onClick={() => {
                  atlas.send({ type: "atlas.ext.remove", id: e.id });
                  onBack();
                }}
              >
                {e.state === "draft" ? "Throw it away" : "Remove"}
              </button>
            )}
            {s.mcp && (
              <button
                className="btn s"
                onClick={() => {
                  atlas.send({ type: "atlas.mcp.remove", id: s.mcp!.id });
                  onBack();
                }}
              >
                Remove
              </button>
            )}
            <span className="grow" />
            {!at("developer") && (
              <button className="btn s" onClick={() => setMore(!more)}>
                {more ? "Hide details" : "Show details"}
              </button>
            )}
          </div>
        </div>
        <div className="svc-right">
          <div className="two">
            <Hears s={s} />
            <CanDo atlas={atlas} s={s} />
          </div>
          {e && <Uses atlas={atlas} e={e} view={view} />}
          {s.builtin === "webhooks" && <Webhooks atlas={atlas} view={view} />}
          {s.builtin === "search" && <SearchUse atlas={atlas} view={view} id="cloudflare" />}
          <Lately s={s} />
          {dev && e?.code != null && <Code code={e.code} />}
        </div>
      </div>
    </div>
  );
}

function Hears({ s }: { s: Service }) {
  const e = s.ext;
  const heard = (e?.provides ?? []).map((p) => GIVES[p]?.hears).filter((h): h is string => !!h);
  return (
    <div className="card2 pad">
      <div className="card-head">
        <span className="h2">Hears</span>
        <span className="aside">What Atlas notices from {s.name}</span>
      </div>
      <div className="lines">
        {heard.map((h) => (
          <div className="line" key={h}>
            <span className="grow">{h}</span>
            <span className="aside">{e?.every ? `every ${e.every} min` : e?.address ? "as it happens" : ""}</span>
          </div>
        ))}
        {/* TODO(stage 5): each kind of thing it hears, with a count this week and its own switch, once the manifest names them. */}
        {s.mcp && <p className="aside line">Nothing: an MCP server only answers when Atlas asks.</p>}
        {!heard.length && !s.mcp && <p className="aside line">Nothing on its own. Atlas uses it when it needs it.</p>}
      </div>
    </div>
  );
}

function CanDo({ atlas, s }: { atlas: Atlas; s: Service }) {
  const trusted = atlas.state.view?.permissions.trusted ?? [];
  const does = (s.ext?.provides ?? []).map((p) => GIVES[p]?.does).filter((h): h is string => !!h);
  return (
    <div className="card2 pad">
      <div className="card-head">
        <span className="h2">Can do</span>
        <span className="aside">What Atlas can do there for you</span>
      </div>
      <div className="lines">
        {s.mcp?.tools.map((t) => {
          const trust = trusted.find((x) => x.key.includes(t.name));
          return (
            <div className="line" key={t.name}>
              <span className="grow clip" title={t.description}>
                {t.title ?? t.name}
              </span>
              <span className={`small ${trust ? "ok" : "muted"}`}>
                {t.reads
                  ? "Never asks"
                  : trust
                    ? `Trusted since ${new Date(trust.since).toLocaleDateString([], { month: "short", day: "numeric" })}`
                    : "Asks until trusted"}
              </span>
            </div>
          );
        })}
        {does.map((d) => (
          <div className="line" key={d}>
            <span className="grow">{d}</span>
          </div>
        ))}
        {s.builtin === "email" && (
          <div className="line">
            <span className="grow">Sends and receives mail as itself</span>
            <span className="small muted">Asks until trusted</span>
          </div>
        )}
        {s.builtin === "webhooks" && (
          <div className="line">
            <span className="grow">Calls your webhooks</span>
            <span className="small muted">Asks until trusted</span>
          </div>
        )}
        {s.builtin === "search" && (
          <div className="line">
            <span className="grow">Searches the web</span>
            <span className="small muted">Never asks</span>
          </div>
        )}
        {s.mcp && !s.mcp.tools.length && <p className="aside line">Its tools show once it connects.</p>}
        {!s.mcp && !does.length && !s.builtin && <p className="aside line">It only tells Atlas things; it doesn't act.</p>}
      </div>
    </div>
  );
}

/** What's happened lately: its last error in the service's own words, and when it last worked. */
function Lately({ s }: { s: Service }) {
  const e = s.ext;
  const rows: Array<{ k: string; text: string; at: number | null; bad?: boolean }> = [];
  if (e?.error) rows.push({ k: "Failed", text: e.error, at: e.error_at, bad: true });
  if (s.mcp?.error) rows.push({ k: "Failed", text: s.mcp.error, at: null, bad: true });
  if (e?.ok_at) rows.push({ k: "Worked", text: "Its last call went through", at: e.ok_at });
  if (e?.last_look) rows.push({ k: "Looked", text: "Checked for anything new", at: e.last_look });
  return (
    <div className="card2 pad">
      <div className="card-head">
        <span className="h2">Lately</span>
        <span className="grow" />
        <span className="aside">Every one is in History</span>
      </div>
      {/* TODO(core): what it heard and did lately, item by item ("Heard: Color grade export fails"), once History can be asked per service. */}
      <div className="lines">
        {rows.map((r) => (
          <div className="line" key={r.k}>
            <span className={`small row ${r.bad ? "ac" : "muted"}`} style={{ width: 70, gap: 6, flexWrap: "nowrap" }}>
              <span className={`sdot ${r.bad ? "needs" : "asleep"}`} />
              {r.k}
            </span>
            <span className={`grow ${r.bad ? "" : "muted"}`} style={{ overflowWrap: "anywhere" }}>
              {r.text}
            </span>
            <span className="aside">{r.at ? dayTime(r.at) : ""}</span>
          </div>
        ))}
        {!rows.length && <p className="aside line">Nothing yet.</p>}
      </div>
    </div>
  );
}

function Code({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card2 pad">
      <button className="tbtn" onClick={() => setOpen(!open)}>
        {open ? "Hide its code" : "Read its code"}
      </button>
      {open && <pre className="code-block mono small">{code}</pre>}
    </div>
  );
}

/** Its key or sign-in, its settings, its setup (shown once) and a live test. */
function Connection({ atlas, e, dev }: { atlas: Atlas; e: ExtensionView; dev: boolean }) {
  const [change, setChange] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>(() => Object.fromEntries(e.settings.map((x) => [x.name, x.value])));
  const setup = atlas.state.extSetup[e.id];
  if (e.state === "available" || e.state === "draft") return null;
  // Nothing to connect or set: no card at all.
  if (
    !e.secrets.length &&
    !e.signin &&
    !e.settings.length &&
    !setup &&
    !e.methods.some((m) => m === "setup" || m === "test") &&
    !(e.address && dev)
  )
    return null;
  const keyed = e.secrets.filter((x) => !x.optional).every((x) => x.set) && (!e.signin || e.signin.signed_in);
  const works = keyed && !extState(e).said.startsWith("Failing");
  const showFields = change || !keyed || dev;
  return (
    <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {(e.secrets.length > 0 || e.signin) && (
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <span style={{ fontWeight: 600 }} className="grow">
            {keyed ? (e.signin ? "Signed in" : "Connected with your key") : e.signin ? "Sign in to connect it" : "Connect it with your key"}
          </span>
          {works && (
            <span className="ok small">
              <Icon name="check" size={11} /> Works
            </span>
          )}
        </div>
      )}
      {e.secrets.length > 0 && (
        <span className="aside">Atlas keeps it locked away and adds it as each request leaves. Nothing else ever sees it.</span>
      )}
      {showFields &&
        e.secrets.map((x) => (
          <div key={x.name}>
            <SecretField
              label={`${x.label}${x.optional ? " (optional)" : ""}`}
              set={x.set}
              onSave={(value) => atlas.send({ type: "atlas.ext.secrets", id: e.id, secrets: { [x.name]: value?.trim() ?? null } })}
            />
            {x.help && <span className="aside">{x.help}</span>}
          </div>
        ))}
      {e.signin && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {showFields && <span className="small">{e.signin.help}</span>}
          {showFields && e.signin.redirect && (
            <span className="small">
              Its redirect address: <span className="mono">{e.signin.redirect}</span>
            </span>
          )}
          {showFields && (
            <SecretField
              label="Client secret"
              set={e.signin.secret_set}
              onSave={(value) => atlas.send({ type: "atlas.ext.secrets", id: e.id, secrets: { client_secret: value?.trim() ?? null } })}
            />
          )}
          <div className="row">
            <button className="btnp s" onClick={() => atlas.send({ type: "atlas.ext.signin", id: e.id })}>
              {e.signin.signed_in ? "Sign in again" : "Sign in"}
            </button>
            {e.signin.signed_in && (
              <button
                className="btn s"
                onClick={() =>
                  atlas.send({
                    type: "atlas.ext.secrets",
                    id: e.id,
                    secrets: { access_token: null, refresh_token: null, expires_at: null },
                  })
                }
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
      {keyed && !showFields && e.secrets.length > 0 && (
        <span>
          <button className="btn s" onClick={() => setChange(true)}>
            Change the key
          </button>
        </span>
      )}
      {e.settings.map((x) => (
        <label className="field" key={x.name}>
          <span>{x.label}</span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              value={settings[x.name] ?? ""}
              spellCheck={false}
              autoComplete="off"
              onChange={(ev) => setSettings({ ...settings, [x.name]: ev.target.value })}
            />
            <button
              type="button"
              className="btn s"
              disabled={(settings[x.name] ?? "") === x.value}
              onClick={() => atlas.send({ type: "atlas.ext.settings", id: e.id, settings: { [x.name]: settings[x.name] ?? "" } })}
            >
              Save
            </button>
          </div>
          {x.help && <span className="aside">{x.help}</span>}
        </label>
      ))}
      {e.address && dev && (
        <span className="small">
          Its address, for the service to post to:{" "}
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {e.address}
          </span>
        </span>
      )}
      {setup && (
        <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
          {setup.link && <QrCode text={setup.link} size={150} />}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
            <p className={`small ${setup.ok ? "" : "err"}`}>{setup.text}</p>
            {setup.link && (
              <a className="btnp s" href={setup.link} style={{ textDecoration: "none", alignSelf: "flex-start" }}>
                Open it
              </a>
            )}
            {(setup.fields ?? []).map((f) => (
              <span className="aside" key={f.label}>
                {f.label}:{" "}
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {f.value}
                </span>
              </span>
            ))}
            {setup.fields?.length ? <span className="aside">This is the only time these are shown.</span> : null}
          </div>
        </div>
      )}
      <div className="row">
        {e.methods.includes("setup") && (
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.ext.setup", id: e.id })}>
            {setup ? "Set up again" : "Set up"}
          </button>
        )}
        {e.methods.includes("test") && (
          <TestRow label="Test it" k={`ext:${e.id}`} atlas={atlas} run={() => atlas.send({ type: "atlas.ext.test", id: e.id })} />
        )}
      </div>
    </div>
  );
}

/** One extension as a compact card with its setup, for places outside Abilities (setup's calendar step). */
export function ExtensionCard({ atlas, e }: { atlas: Atlas; e: ExtensionView }) {
  const s = extState(e);
  return (
    <div className="card2 pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
        <Logo of={e.id} name={e.name} size={34} />
        <span className="grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{e.name}</span>
          <span className="aside clip">{e.about}</span>
        </span>
        {e.state === "available" || e.state === "draft" ? (
          <button className="btnp s" onClick={() => atlas.send({ type: "atlas.ext.install", id: e.id })}>
            Set it up
          </button>
        ) : (
          <span className="row small" style={{ gap: 6 }}>
            <StateDot state={s.state} /> {s.said}
          </span>
        )}
      </div>
      {e.error && <span className="err small">{e.error}</span>}
      <Connection atlas={atlas} e={e} dev={false} />
    </div>
  );
}

function McpConnection({ atlas, m }: { atlas: Atlas; m: McpServerView }) {
  const { at } = useDetail();
  return (
    <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>
        {m.state === "ready" ? "Connected" : m.state === "authenticating" ? "Sign in to connect it" : "Connecting"}
      </span>
      {m.auth_url && (
        <a
          className="btnp s"
          href={m.auth_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ alignSelf: "flex-start", textDecoration: "none" }}
        >
          Sign in
        </a>
      )}
      {m.error && <span className="err small">{m.error}</span>}
      {at("developer") && (
        <span className="mono aside" style={{ wordBreak: "break-all" }}>
          {m.url}
        </span>
      )}
      <span className="aside">Tools that only read run without asking; the rest ask first, until you trust them.</span>
      {!atlas.voice.connected && <span className="aside">Reconnecting.</span>}
    </div>
  );
}

/** What else an extension is for, in Atlas: web search, maps, the calendars it reads, your chat link, contacts. */
function Uses({ atlas, e, view }: { atlas: Atlas; e: ExtensionView; view: SettingsView }) {
  if (e.state !== "on") return null;
  const parts = [];
  if (e.provides.includes("search")) parts.push(<SearchUse key="search" atlas={atlas} view={view} id={e.id} />);
  if (e.provides.includes("maps"))
    parts.push(
      <div className="line" key="maps">
        <span className="grow">Atlas's maps and routes come from {e.name}</span>
        <Toggle
          on={view.settings.maps.provider === e.id}
          label={`Maps from ${e.name}`}
          onChange={(on) => on && atlas.send({ type: "atlas.settings.update", patch: { maps: { provider: e.id } } })}
        />
      </div>,
    );
  if (e.provides.includes("calendar")) parts.push(<Calendars key="cal" atlas={atlas} view={view} />);
  if (e.provides.includes("channel")) parts.push(<ChatLink key="chat" atlas={atlas} view={view} ext={e.id} />);
  if (e.methods.includes("contacts"))
    parts.push(
      <div className="line" key="contacts">
        <span className="grow">Bring the people in your contacts into what Atlas knows</span>
        <TestRow
          label="Bring in contacts"
          k="contacts"
          atlas={atlas}
          run={() => atlas.send({ type: "atlas.contacts.import", from: e.id })}
        />
      </div>,
    );
  if (e.provides.includes("location")) parts.push(<Location key="loc" atlas={atlas} view={view} />);
  if (!parts.length) return null;
  return (
    <div className="card2 pad">
      <div className="card-head">
        <span className="h2">In Atlas</span>
        <span className="aside">What it's used for</span>
      </div>
      <div className="lines">{parts}</div>
    </div>
  );
}

function SearchUse({ atlas, view, id }: { atlas: Atlas; view: SettingsView; id: string }) {
  const on = view.settings.web.search === id;
  return (
    <div className="line">
      <span className="grow">Atlas searches the web with it</span>
      {on && <TestRow label="Test" k="search" atlas={atlas} run={() => atlas.test("search", { type: "atlas.test", what: "search" })} />}
      <Toggle
        on={on}
        label="Search the web with it"
        onChange={(v) => v && atlas.send({ type: "atlas.settings.update", patch: { web: { search: id } } })}
      />
    </div>
  );
}

function Calendars({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const [hidden, setHidden] = useState(view.settings.calendar.hidden.join(", "));
  const cal = view.calendar;
  return (
    <>
      {cal.refused && <p className="err small line">{cal.refused.note}</p>}
      <div className="line">
        <span className="grow">Calendars to leave out</span>
        <input value={hidden} placeholder="None" onChange={(e) => setHidden(e.target.value)} style={{ width: 200 }} />
        <button
          className="btn s"
          onClick={() =>
            atlas.send({
              type: "atlas.settings.update",
              patch: {
                calendar: {
                  hidden: hidden
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              },
            })
          }
        >
          Save
        </button>
      </div>
      <div className="line">
        <span className="grow">Read your calendar now</span>
        <TestRow label="Test" k="calendar" atlas={atlas} run={() => atlas.test("calendar", { type: "atlas.test", what: "calendar" })} />
      </div>
    </>
  );
}

/** Who you are on a chat channel (§16.1): message the bot from your own account, then send it the code shown here. */
function ChatLink({ atlas, view, ext }: { atlas: Atlas; view: SettingsView; ext: string }) {
  const c = view.channels.find((x) => x.ext === ext);
  const code = atlas.state.channelCode;
  const now = useNow(30_000);
  if (!c) return null;
  return (
    <>
      <div className="line">
        <span className="grow">
          {c.linked
            ? `You're ${c.linked.name || "linked"} there, so your messages are you talking to Atlas.`
            : "It doesn't know you there yet."}
        </span>
        {c.linked ? (
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.channel.unlink", ext })}>
            Unlink
          </button>
        ) : (
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.channel.code", ext })}>
            Link my account
          </button>
        )}
      </div>
      {code && code.ext === ext && code.expires > now && !c.linked && (
        <p className="small line">
          Send <b className="mono">{code.code}</b> to the bot from your own account, within 15 minutes.
        </p>
      )}
    </>
  );
}

/** Location (§10.1): OwnTracks on the phone, its last fix and place, and the switch that stops it at once. */
export function Location({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const l = view.location;
  const on = view.settings.location.on;
  return (
    <>
      <div className="line">
        <span className="grow">
          {!on
            ? "Off: Atlas drops what the phone sends"
            : !l.set_up
              ? "Not set up on your phone yet"
              : l.place
                ? `At ${l.place.name} since ${dayTime(l.place.since)}`
                : l.fix
                  ? `Last fix ${ago(l.fix.at)}`
                  : "Waiting for your phone"}
        </span>
        <Toggle
          on={on}
          label="Take in my location"
          onChange={(v) => atlas.send({ type: "atlas.settings.update", patch: { location: { on: v } } })}
        />
      </div>
      <p className="aside line">
        {l.pins} saved {l.pins === 1 ? "place has" : "places have"} a pin, so arriving and leaving are noticed. Say "this is my gym" to add
        one.
      </p>
      {l.refused && (
        <p className="err small line">
          A post with the wrong password came {dayTime(l.refused.at)}. If that was your phone, set it up again.
        </p>
      )}
    </>
  );
}

/** Atlas's own address (§16.2): atlas@ your domain, with a token for the domain's Cloudflare account. */
function AtlasEmail({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const m = view.mail;
  const [domain, setDomain] = useState(m.domain ?? "");
  const [token, setToken] = useState("");
  const [sending, setSending] = useState(m.sending ?? "cloudflare");
  const [busy, setBusy] = useState(false);
  const note = atlas.state.tests.mail;
  useEffect(() => setBusy(false), [note]);
  const go = (msg: Parameters<Atlas["send"]>[0]) => {
    setBusy(true);
    atlas.send(msg);
  };
  return (
    <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <span style={{ fontWeight: 600 }}>{m.address ? m.address : "Set it up on your domain"}</span>
      {m.on_subdomain && <span className="aside">It's on a subdomain, since your domain's own mail goes to another provider.</span>}
      {m.sending_note && <span className="err small">{m.sending_note}</span>}
      <input
        value={domain}
        placeholder="Your domain, like example.com"
        onChange={(e) => setDomain(e.target.value)}
        aria-label="Your domain"
      />
      <input
        type="password"
        autoComplete="off"
        value={token}
        aria-label="A token for the domain's Cloudflare account"
        placeholder={m.address ? "A new token, or leave empty to keep it" : "A token for the domain's Cloudflare account"}
        onChange={(e) => setToken(e.target.value)}
      />
      <details className="small">
        <summary>What the token needs</summary>
        <ul className="small">
          {m.permissions.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </details>
      <div className="row">
        <span className="small muted">Sends with</span>
        <div className="seg" role="radiogroup">
          {[{ id: "cloudflare", name: "Cloudflare" }, ...m.senders].map((x) => (
            <button key={x.id} type="button" className={sending === x.id ? "on" : ""} onClick={() => setSending(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <button
          className="btnp s"
          disabled={busy || domain.trim().length < 3 || (!m.address && !token.trim())}
          onClick={() => go({ type: "atlas.mail.setup", domain: domain.trim(), sending, ...(token.trim() ? { token: token.trim() } : {}) })}
        >
          {m.address ? "Set up again" : "Set up"}
        </button>
        {m.address && (
          <>
            <button className="btn s" disabled={busy} onClick={() => go({ type: "atlas.mail.test" })}>
              Send a test
            </button>
            <button className="btn s" disabled={busy} onClick={() => go({ type: "atlas.mail.remove" })}>
              Take it down
            </button>
          </>
        )}
      </div>
      {note && <span className={`small ${note.ok ? "ok" : "err"}`}>{note.message}</span>}
    </div>
  );
}

/** Your own webhooks: ones Atlas calls (it asks first), and sources that post to Atlas, each with its own address. */
function Webhooks({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const blank = { id: undefined as string | undefined, name: "", url: "", method: "POST" as "POST" | "GET", about: "" };
  const [form, setForm] = useState(blank);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const made = atlas.state.senseHook;
  const editing = form.id != null;
  return (
    <>
      <div className="card2 pad">
        <div className="card-head">
          <span className="h2">Atlas calls</span>
          <span className="aside">It asks before calling one, until you trust it.</span>
          <span className="grow" />
          {!open && (
            <button className="btn s" onClick={() => setOpen(true)}>
              Add one
            </button>
          )}
        </div>
        <div className="lines">
          {view.webhooks.map((w) => (
            <div className="line" key={w.id}>
              <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>{w.name}</span>
                <span className="aside">{w.about || `${w.method} ${w.host}`}</span>
              </span>
              <TestRow
                label="Call it"
                k={`webhook:${w.id}`}
                atlas={atlas}
                run={() => atlas.test(`webhook:${w.id}`, { type: "atlas.test", what: "webhook", id: w.id })}
              />
              <button
                className="tbtn"
                onClick={() => {
                  setForm({ id: w.id, name: w.name, url: "", method: w.method, about: w.about });
                  setOpen(true);
                }}
              >
                Edit
              </button>
              <button className="tbtn" onClick={() => atlas.send({ type: "atlas.webhook.remove", id: w.id })}>
                Remove
              </button>
            </div>
          ))}
          {!view.webhooks.length && <p className="aside line">None yet. Lights, scenes, anything with a web address.</p>}
        </div>
        {open && (
          <form
            className="vault-form"
            onSubmit={(e) => {
              e.preventDefault();
              atlas.send({ type: "atlas.webhook.save", ...form, url: form.url.trim() || undefined });
              setForm(blank);
              setOpen(false);
            }}
          >
            <input
              value={form.name}
              maxLength={60}
              placeholder="Its name, like Lights off"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className="mono"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={form.url}
              placeholder={editing ? "Kept. Paste a new address to change it." : "https://"}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <input
              value={form.about}
              maxLength={300}
              placeholder="What it does, so Atlas knows when to use it"
              onChange={(e) => setForm({ ...form, about: e.target.value })}
            />
            <div className="row">
              <div className="seg" role="radiogroup" aria-label="Method">
                {(["POST", "GET"] as const).map((m) => (
                  <button key={m} type="button" className={form.method === m ? "on" : ""} onClick={() => setForm({ ...form, method: m })}>
                    {m}
                  </button>
                ))}
              </div>
              <button className="btnp s" disabled={!form.name.trim() || (!editing && !/^https:\/\/./.test(form.url.trim()))}>
                {editing ? "Save" : "Add"}
              </button>
              <button
                type="button"
                className="btn s"
                onClick={() => {
                  setForm(blank);
                  setOpen(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="card2 pad">
        <div className="card-head">
          <span className="h2">Post to Atlas</span>
          <span className="aside">Any service that can post gets its own address.</span>
        </div>
        <div className="lines">
          {view.senses.hooks.map((h) => (
            <div className="line" key={h.id}>
              <span className="grow" style={{ fontWeight: 500 }}>
                {h.name}
              </span>
              <span className="aside">{h.last_at ? `last post ${ago(h.last_at)}` : "no posts yet"}</span>
              <button className="tbtn" onClick={() => atlas.send({ type: "atlas.sense.hook.remove", id: h.id })}>
                Remove
              </button>
            </div>
          ))}
          {made && view.senses.hooks.some((h) => h.id === made.id) && (
            <div className="line" style={{ flexDirection: "column", alignItems: "flex-start", padding: "8px 0" }}>
              <span className="small">{made.name}'s address, shown once. Anyone with it can post to Atlas, so keep it private.</span>
              <code className="small mono" style={{ wordBreak: "break-all", userSelect: "all" }}>
                {made.url}
              </code>
            </div>
          )}
          <div className="line">
            <input
              value={source}
              maxLength={60}
              placeholder="A service, like GitHub or Home server"
              onChange={(e) => setSource(e.target.value)}
            />
            <button
              className="btn s"
              disabled={!source.trim()}
              onClick={() => {
                atlas.send({ type: "atlas.sense.hook.add", name: source.trim() });
                setSource("");
              }}
            >
              Make an address
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
