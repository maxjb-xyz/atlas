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
import { ago, AreaChip, dayTime, Icon, Logo, logoFor, pressable, QrCode, StateDot, Toggle, useNow } from "../ui";
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
  const all = services(view, atlas.state.mcpServers, atlas.state.services);
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

export function SvcLogo({ s, size = 34 }: { s: Service; size?: number }) {
  if (s.builtin === "webhooks")
    return (
      <span className="logo" style={{ width: size, height: size, borderRadius: 8 }}>
        <Icon name="globe" size={Math.round(size * 0.5)} />
      </span>
    );
  // The catalog's own logo when the app has none for it.
  if (s.icon && !logoFor(s.logo) && !logoFor(s.name))
    return (
      <span className="logo" style={{ width: size, height: size, borderRadius: size > 40 ? 11 : 8 }}>
        <img
          className={`lg ${s.svc?.icon_invert ? "inv" : ""}`}
          src={s.icon}
          width={Math.round(size * 0.58)}
          height={Math.round(size * 0.58)}
          alt=""
        />
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
  const v = s.svc;
  const note = atlas.state.serviceNote?.id === s.key ? atlas.state.serviceNote : null;
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [note, v?.state]);
  const act = (m: Parameters<Atlas["send"]>[0]) => {
    setBusy(true);
    atlas.send(m);
  };
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
          {v?.error && (v.error.part !== "mcp" || !s.mcp) && (
            <div className="card2 pad bad-card">
              <span style={{ fontWeight: 600 }}>{v.error.part === "mcp" ? "Its tools didn't connect" : "Its last call failed"}</span>
              <span className="small" style={{ overflowWrap: "anywhere" }}>
                {v.error.text}
              </span>
              {v.error.at && <span className="aside">{dayTime(v.error.at)}</span>}
            </div>
          )}
          {note && <p className={`small ${note.ok ? "ok" : "err"}`}>{note.text}</p>}
          {v && v.setup.kind === "key" && v.state !== "available" && (!(e?.secrets.some((x) => x.set) ?? false) || dev) && (
            <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{v.setup.label}</span>
              <span className="aside">{v.setup.help}</span>
              <SecretField
                label={v.setup.label}
                set={v.setup.set}
                onSave={(key) => key && act({ type: "atlas.service.key", id: s.key, key })}
              />
              {v.setup.covers.length > 1 && <span className="aside">One key covers its events and its tools.</span>}
            </div>
          )}
          {e && <Connection atlas={atlas} e={e} dev={dev} />}
          {s.mcp && <McpConnection atlas={atlas} m={s.mcp} svc={v} />}
          {v?.parts.mcp && !s.mcp && v.state !== "available" && (
            <div className="card2 dim pad">
              <span style={{ fontWeight: 600 }}>Its tools aren't connected</span>
              <span className="aside">
                {v.setup.kind === "key" && !v.setup.set && e?.secrets.some((x) => x.set)
                  ? " Connect them with the key it already has."
                  : v.setup.kind === "key"
                    ? " Add its key above, and Atlas connects them."
                    : " Connect them to sign in."}
              </span>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn s" disabled={busy} onClick={() => act({ type: "atlas.service.install", id: s.key })}>
                  {busy ? "Connecting" : "Connect them"}
                </button>
              </div>
            </div>
          )}
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
            {v && v.state === "available" && (
              <button className="btnp s" disabled={busy} onClick={() => act({ type: "atlas.service.install", id: s.key })}>
                {busy ? "Setting it up" : "Set it up"}
              </button>
            )}
            {v?.update && (
              <button className="btnp s" disabled={busy} onClick={() => act({ type: "atlas.service.update", id: s.key })}>
                Update to {v.update.version}
              </button>
            )}
            {!v && e && (e.state === "available" || e.state === "draft") && (
              <button className="btnp s" onClick={() => atlas.send({ type: "atlas.ext.install", id: e.id })}>
                {e.state === "draft" ? "Install it" : "Set it up"}
              </button>
            )}
            {e && e.state !== "available" && e.state !== "draft" && (
              <button className="btn s" onClick={() => atlas.send({ type: "atlas.ext.state", id: e.id, on: e.state !== "on" })}>
                {e.state === "on" ? "Turn off" : "Turn on"}
              </button>
            )}
            {v && v.state !== "available" && !v.id.startsWith("mcp:") && (
              <button
                className="btn s"
                onClick={() => {
                  atlas.send({ type: "atlas.service.remove", id: s.key });
                  onBack();
                }}
              >
                {v.state === "draft" ? "Throw it away" : "Remove"}
              </button>
            )}
            {!v && e && e.state !== "available" && (
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
            {s.mcp && (!v || v.id.startsWith("mcp:")) && (
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
          {v && v.state !== "available" && (v.accounts.length > 1 || v.more) && <Accounts atlas={atlas} svc={v} dev={dev} />}
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
        {s.mcp && !heard.length && <p className="aside line">Nothing: an MCP server only answers when Atlas asks.</p>}
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
/** Whether an account is set up enough to use: its keys in, and signed in when it signs in. */
export const signedIn = (e: ExtensionView) => e.secrets.every((x) => x.optional || x.set) && (!e.signin || e.signin.signed_in);

/**
 * A service's accounts (§17): each with its name (what it signed into, or the
 * owner's), its state, and, opened, its own sign-in; another can be added.
 * The first account's sign-in is the card's own, above. With more than one
 * mail account, one is where new mail as the owner goes from by default.
 */
export function Accounts({ atlas, svc, dev }: { atlas: Atlas; svc: NonNullable<Service["svc"]>; dev: boolean }) {
  const view = atlas.state.view!;
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  const exts = svc.accounts.map((a) => ({ a, e: view.extensions.find((x) => x.id === a.ext) })).filter((x) => x.e);
  const mail = exts.some((x) => x.e!.provides.includes("mail"));
  const allMail = view.extensions.filter((x) => x.state === "on" && x.provides.includes("mail") && signedIn(x));
  const byDefault = view.settings.accounts.mail || allMail[0]?.id || "";
  const areas = atlas.state.areas.filter((x) => x.state !== "archived");
  const calendarsOf = Object.fromEntries(view.calendar.providers.map((p) => [p.id, p.calendars]));
  const defaultCal = view.settings.accounts.calendar;
  // An account is in an area when the area's new mail goes from it, or the whole account is among the area's calendars.
  const accountAreas = (ext: string) => areas.filter((x) => x.settings.mail === ext || x.settings.calendars.includes(ext)).map((x) => x.id);
  // A new account opens on its sign-in.
  const [count, setCount] = useState(exts.length);
  useEffect(() => {
    if (exts.length > count) setOpen(exts.at(-1)!.a.ext);
    setCount(exts.length);
  }, [exts.length]);
  return (
    <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontWeight: 600 }}>Accounts</span>
      <span className="aside">
        Each signs in on its own. Put one in an area, or just one of its calendars: new mail and events there use it, and its events are
        that area's.
      </span>
      <div className="lines">
        {exts.map(({ a, e }, i) => (
          <div key={a.ext}>
            <div className="line">
              <StateDot state={extState(e!).state} />
              {naming?.id === a.ext ? (
                <form
                  className="row grow"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    atlas.send({ type: "atlas.ext.account.name", id: a.ext, name: naming.name });
                    setNaming(null);
                  }}
                >
                  <input
                    className="grow"
                    autoFocus
                    value={naming.name}
                    placeholder="Work, Personal…"
                    onChange={(x) => setNaming({ id: a.ext, name: x.target.value })}
                  />
                  <button className="btn s" type="submit">
                    Save
                  </button>
                </form>
              ) : (
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="clip">{a.name ?? `Account ${i + 1}`}</span>
                  <span className="aside"> · {extState(e!).said}</span>
                  {dev && <span className="mono aside"> · {a.ext}</span>}
                </span>
              )}
              {mail && allMail.length > 1 && e!.state === "on" && signedIn(e!) && (
                <button
                  className={`tbtn ${byDefault === a.ext ? "on" : ""}`}
                  title="New mail as you goes from this one, unless an area says another"
                  onClick={() =>
                    atlas.send({ type: "atlas.settings.update", patch: { accounts: { ...view.settings.accounts, mail: a.ext } } })
                  }
                >
                  {byDefault === a.ext ? "Sends new mail" : "Send new mail from it"}
                </button>
              )}
              {/* The areas this account is for: mail there goes from it, and its events are theirs. */}
              {areas.length > 0 && e!.state === "on" && (
                <AreaChip
                  ids={accountAreas(a.ext)}
                  areas={areas}
                  onMove={(ids) => atlas.send({ type: "atlas.ext.account.areas", id: a.ext, areas: ids })}
                />
              )}
              <button className="tbtn" onClick={() => setNaming({ id: a.ext, name: a.name ?? "" })}>
                Name
              </button>
              {i > 0 && (
                <>
                  <button className="tbtn" onClick={() => setOpen(open === a.ext ? null : a.ext)}>
                    {open === a.ext ? "Close" : "Sign-in"}
                  </button>
                  <button className="tbtn" onClick={() => atlas.send({ type: "atlas.ext.remove", id: a.ext })}>
                    Remove
                  </button>
                </>
              )}
            </div>
            {open === a.ext && <Connection atlas={atlas} e={e!} dev={dev} />}
            {/* Each of its calendars can be put in an area of its own, and one is where new events go. */}
            {e!.provides.includes("calendar") && (calendarsOf[a.ext] ?? []).length > 0 && (
              <div className="lines" style={{ paddingLeft: 22 }}>
                {(calendarsOf[a.ext] ?? []).map((name) => {
                  const ref = `${a.ext}::${name}`;
                  return (
                    <div className="line" key={ref}>
                      <Icon name="calendar" size={13} style={{ color: "var(--tx3)" }} />
                      <span className="grow small clip">{name}</span>
                      {areas.length > 0 && (
                        <AreaChip
                          ids={areas.filter((x) => x.settings.calendars.includes(ref)).map((x) => x.id)}
                          areas={areas}
                          onMove={(ids) => atlas.send({ type: "atlas.ext.account.areas", id: a.ext, calendar: name, areas: ids })}
                        />
                      )}
                      <button
                        className={`tbtn ${defaultCal === ref ? "on" : ""}`}
                        title="New events go here, unless an area says another"
                        onClick={() =>
                          atlas.send({ type: "atlas.settings.update", patch: { accounts: { ...view.settings.accounts, calendar: ref } } })
                        }
                      >
                        {defaultCal === ref ? "Gets new events" : "New events here"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {svc.more && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.ext.account.add", id: svc.accounts[0]?.ext ?? svc.id })}>
            <Icon name="plus" size={12} /> Add another account
          </button>
        </div>
      )}
    </div>
  );
}

export function Connection({ atlas, e, dev }: { atlas: Atlas; e: ExtensionView; dev: boolean }) {
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

function McpConnection({ atlas, m, svc }: { atlas: Atlas; m: McpServerView; svc?: Service["svc"] }) {
  const { at } = useDetail();
  const [token, setToken] = useState("");
  const failed = m.state === "failed";
  const why = m.error ?? (svc?.error?.part === "mcp" ? svc.error.text : null);
  const byToken = !svc || svc.parts.mcp?.signin !== "oauth";
  return (
    <div className="card2 dim pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontWeight: 600 }}>
        {m.state === "ready"
          ? `Its tools: ${m.tools.length} connected`
          : m.state === "authenticating"
            ? "Sign in to connect its tools"
            : failed
              ? "Its tools didn't connect"
              : "Connecting its tools"}
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
      {failed && (
        <span className="err small" style={{ overflowWrap: "anywhere" }}>
          {why ?? "It gave no reason. Try again to hear what it says now."}
        </span>
      )}
      {failed && (
        <div className="row">
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.mcp.retry", id: m.id })}>
            Try again
          </button>
        </div>
      )}
      {failed && byToken && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!token.trim()) return;
            if (svc && !svc.id.startsWith("mcp:")) atlas.send({ type: "atlas.service.key", id: svc.id, key: token.trim() });
            else atlas.send({ type: "atlas.mcp.add", name: m.name, url: m.url, token: token.trim() });
            setToken("");
          }}
        >
          <input
            className="mono grow"
            type="password"
            autoComplete="off"
            value={token}
            placeholder="A new token, if the old one stopped working"
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn s" type="submit" disabled={!token.trim()}>
            Use it
          </button>
        </form>
      )}
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
  if ((e.provides as string[]).includes("calls")) parts.push(<Phone key="calls" atlas={atlas} view={view} />);
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

export function SearchUse({ atlas, view, id }: { atlas: Atlas; view: SettingsView; id: string }) {
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

export function Calendars({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
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

/**
 * Phone calls (§16.1): the account's numbers with what each is connected to,
 * one moved to Atlas and given back, numbers to buy with their price, and a
 * test call. Only the number picked changes; the account's others stay.
 */
export function Phone({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const c = atlas.state.calls;
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    atlas.send({ type: "atlas.calls.numbers" });
  }, [atlas]);
  useEffect(() => setBusy(false), [c]);
  const ask = (m: Parameters<Atlas["send"]>[0]) => {
    setBusy(true);
    atlas.send(m);
  };
  const calls = view.settings.permissions.calls;
  const mine = view.settings.phone.mine;
  const [num, setNum] = useState("");
  const setMine = (next: string[]) => atlas.send({ type: "atlas.settings.update", patch: { phone: { mine: next } } });
  return (
    <>
      <div className="line">
        <span className="grow">
          Your own numbers
          <span className="aside">
            {" "}
            · a call from one of these, with caller ID the phone network vouches for, is you. Atlas calls the first.
          </span>
        </span>
      </div>
      {mine.map((n) => (
        <div className="line" key={n}>
          <span className="grow mono">{n}</span>
          <button className="tbtn" onClick={() => setMine(mine.filter((x) => x !== n))}>
            Remove
          </button>
        </div>
      ))}
      {mine.length < 4 && (
        <form
          className="line"
          onSubmit={(e) => {
            e.preventDefault();
            if (num.replace(/\D/g, "").length >= 7) {
              setMine([...mine, num.trim()]);
              setNum("");
            }
          }}
        >
          <input className="grow" value={num} placeholder="+1 555 010 9999" onChange={(e) => setNum(e.target.value)} />
          <button className="btn s" type="submit" disabled={num.replace(/\D/g, "").length < 7}>
            Add my number
          </button>
        </form>
      )}
      <div className="line">
        <span className="grow">
          {c?.number ? `Atlas answers ${c.number}.` : "Atlas doesn't have a number yet: use one of yours, or buy one."}
        </span>
        {c?.number && (
          <button className="btn s" disabled={busy} onClick={() => ask({ type: "atlas.calls.test" })}>
            Call me to test
          </button>
        )}
      </div>
      {(c?.numbers ?? []).map((n) => (
        <div className="line" key={n.id}>
          <span className="grow">
            <span className="mono">{n.number}</span>
            <span className="aside"> · {n.ours ? "Atlas" : n.connected ? `now goes to ${n.connected}` : "not connected to anything"}</span>
          </span>
          {n.ours ? (
            <button className="btn s" disabled={busy} onClick={() => ask({ type: "atlas.calls.release" })}>
              Give the number back
            </button>
          ) : (
            <button className="btn s" disabled={busy || n.status !== "active"} onClick={() => ask({ type: "atlas.calls.use", id: n.id })}>
              Use for Atlas
            </button>
          )}
        </div>
      ))}
      <div className="line">
        <span className="grow">Buy a number for Atlas</span>
        <input value={area} placeholder="Area code" onChange={(e) => setArea(e.target.value)} style={{ width: 110 }} />
        <button
          className="btn s"
          disabled={busy}
          onClick={() => ask({ type: "atlas.calls.available", ...(area.trim() ? { area: area.trim() } : {}) })}
        >
          Look
        </button>
      </div>
      {(c?.offers ?? []).map((o) => (
        <div className="line" key={o.number}>
          <span className="grow">
            <span className="mono">{o.number}</span>
            <span className="aside">
              {o.where ? ` · ${o.where}` : ""} · {o.currency === "USD" ? "$" : `${o.currency} `}
              {o.monthly} a month, {o.currency === "USD" ? "$" : `${o.currency} `}
              {o.upfront} to start
            </span>
          </span>
          <button className="btn s" disabled={busy} onClick={() => ask({ type: "atlas.calls.order", number: o.number })}>
            Buy
          </button>
        </div>
      ))}
      {c?.text && <p className={`small line ${c.ok ? "" : "err"}`}>{c.text}</p>}
      <div className="line">
        <span className="grow">
          Atlas calls you {calls === "urgent" ? "about what can't wait, when a call is on your list" : "never"}. Change it in Permissions,
          and put a call on your list in Notifications.
        </span>
      </div>
    </>
  );
}

/** Who you are on a chat channel (§16.1): message the bot from your own account, then send it the code shown here. */
export function ChatLink({ atlas, view, ext }: { atlas: Atlas; view: SettingsView; ext: string }) {
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
export function AtlasEmail({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
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
      {m.token_links.cloudflare && (
        <div className="small" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <a
            className="btn s"
            style={{ alignSelf: "flex-start" }}
            href={sending === "cloudflare" ? m.token_links.cloudflare : m.token_links.other}
            target="_blank"
            rel="noreferrer"
          >
            Make the token on Cloudflare
          </a>
          <span className="aside">
            It opens Cloudflare's Create token page with what Atlas needs filled in. Under Zone Resources pick your domain, then Continue to
            summary, Create Token, and paste the token here.
          </span>
        </div>
      )}
      <details className="small">
        <summary>What the token needs</summary>
        <ul className="small">
          {m.permissions
            .filter((p) => sending === "cloudflare" || !p.cloudflare)
            .map((p) => (
              <li key={p.text}>
                {p.text} <span className="muted">({p.why})</span>
              </li>
            ))}
        </ul>
        <span className="aside">If Cloudflare's page is missing one, add it there with Add more.</span>
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

/** Which service sends Atlas's own mail: switching needs its address set up, and keeps the domain and its token. */
export function SenderUse({ atlas, view, id }: { atlas: Atlas; view: SettingsView; id: string }) {
  const m = view.mail;
  const on = m.sending === id;
  const note = atlas.state.tests.mail;
  if (!m.address || !m.domain)
    return (
      <div className="line">
        <span className="grow small">It sends once Atlas has an address of its own: set that up under "Mail to it" above.</span>
      </div>
    );
  return (
    <>
      {on && m.sending_note && <p className="err small line">{m.sending_note}</p>}
      <div className="line">
        <span className="grow">Atlas sends its mail with it</span>
        {on && m.sending_ok && (
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.mail.test" })}>
            Send a test
          </button>
        )}
        <Toggle
          on={on}
          label="Send Atlas's mail with it"
          onChange={(v) => v && atlas.send({ type: "atlas.mail.setup", domain: m.domain!, sending: id })}
        />
      </div>
      {note && <p className={`small line ${note.ok ? "ok" : "err"}`}>{note.message}</p>}
    </>
  );
}

/** Your own webhooks: ones Atlas calls (it asks first), and sources that post to Atlas, each with its own address. */
export function Webhooks({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
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
