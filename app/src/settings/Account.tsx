// Atlas settings → Account (docs/ui §8): how you sign in (passkeys), your
// passwords and cards (the vault, §15), updates, and your data: whether
// Atlas's own key locks your secrets (§20), taking a copy of everything,
// going back in time and deleting everything (§23.4), setup, and signing out.

import { useEffect, useState } from "react";
import type { SettingsView } from "../../../core/src/protocol";
import { FIELDS, type VaultKind } from "../../../core/src/vault-fields";
import type { Atlas } from "../connection";
import { HoldButton } from "../Approval";
import { Markdown } from "../Markdown";
import { useDetail } from "../theme";
import { dayTime, Icon, LogoMark, Seg, shortDay, Toggle } from "../ui";
import { AddPasskey, Head } from "./parts";

export function Account({
  atlas,
  view,
  onSignOut,
  onSetup,
}: {
  atlas: Atlas;
  view: SettingsView;
  onSignOut: () => void;
  onSetup: () => void;
}) {
  const { at } = useDetail();
  const [removing, setRemoving] = useState<string | null>(null);
  const [vault, setVault] = useState(false);
  const [ended, setEnded] = useState(false);
  const [open, setOpen] = useState<"back" | "delete" | null>(null);
  const sealed = view.secrets.sealed;
  const data = view.data;
  const deleted = atlas.state.tests.data;
  const count = (k: VaultKind) => view.vault.filter((e) => e.kind === k).length;
  const totp = view.vault.filter((e) => e.totp).length;
  const last = view.vault.filter((e) => e.last_used).sort((a, b) => b.last_used! - a.last_used!)[0];
  const apple = (name: string) => /mac|iphone|ipad|safari/i.test(name);

  return (
    <>
      <Head title="Account" sub="How you sign in, your passwords, updates and your data." />
      <div className="two">
        <div className="card2 pad">
          <div className="card-head">
            <span className="h2">Signing in</span>
            <span className="aside">With passkeys, no passwords.</span>
            <span className="grow" />
            <AddPasskey label="Add a device" />
          </div>
          <div className="lines solid">
            {view.passkeys.map((p) => (
              <div className="line" key={p.id} style={{ minHeight: 56 }}>
                <span className="logo" style={{ width: 32, height: 32 }}>
                  {apple(p.name) ? <LogoMark of="apple" size={16} /> : <Icon name="key" size={15} />}
                </span>
                <span className="grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }} className="clip">
                    {p.name}
                  </span>
                  <span className="aside">Added {shortDay(p.created_at)}</span>
                </span>
                {removing === p.id ? (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="small">{view.passkeys.length === 1 ? "Your last passkey. Remove it?" : "Remove it?"}</span>
                    <button
                      className="tbtn err"
                      onClick={() => {
                        atlas.send({ type: "atlas.passkey.remove", id: p.id });
                        setRemoving(null);
                      }}
                    >
                      Remove
                    </button>
                    <button className="tbtn" onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="aside">{p.last_used ? `Used ${shortDay(p.last_used)}` : "Not used yet"}</span>
                    <button className="tbtn" onClick={() => setRemoving(p.id)} aria-label={`Remove ${p.name}`}>
                      <Icon name="x" size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {!view.passkeys.length && <p className="aside line">No passkeys yet. Until you add one, you sign in with your setup code.</p>}
          </div>
          <p className="aside" style={{ marginTop: 8 }}>
            Lost every passkey? Your setup code still signs you in.
          </p>
        </div>

        <div className="card2 pad">
          <div className="card-head">
            <span className="h2">Passwords and cards</span>
            <span className="aside">Locked away.</span>
            <span className="grow" />
            <button className="btn s" onClick={() => setVault(!vault)}>
              {vault ? "Close" : "Open"}
            </button>
          </div>
          <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
            <span className="disp" style={{ fontSize: 26 }}>
              {view.vault.length}
            </span>
            <span className="muted">kept safe</span>
          </div>
          <div className="row" style={{ gap: 6, margin: "8px 0" }}>
            {(
              [
                ["login", "logins"],
                ["card", "cards"],
                ["key", "service keys"],
              ] as const
            ).map(([k, w]) => (
              <span key={k} className="pill-count">
                <b>{count(k)}</b> {w}
              </span>
            ))}
            {totp > 0 && (
              <span className="pill-count">
                <b>{totp}</b> sign-in codes
              </span>
            )}
          </div>
          <span className="aside">
            Atlas fills them in at the last step and never sees them.
            {last ? ` Last used ${shortDay(last.last_used!)}, for ${last.name}.` : ""}
          </span>
        </div>
      </div>
      {vault && <Vault atlas={atlas} view={view} />}

      <div className="two" style={{ marginTop: 14 }}>
        <Updates atlas={atlas} view={view} />

        <div className="card2 pad">
          <div className="card-head">
            <span className="h2">Your data</span>
            <span className="aside">It's yours, in your own Cloudflare account.</span>
          </div>
          <div className="lines solid">
            <div className="line" style={{ alignItems: "flex-start", padding: "8px 0" }}>
              <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 500 }}>Your secrets</span>
                {sealed.unreadable ? (
                  <span className="err small">A secret can't be read. {sealed.unreadable}</span>
                ) : sealed.state === "on" ? (
                  <span className="aside">Your keys, sign-ins and vault are locked with this Atlas's own key, on top of Cloudflare's.</span>
                ) : (
                  <span className="small">
                    {sealed.state === "short"
                      ? "ATLAS_DATA_KEY is shorter than 32 characters, so it isn't used. "
                      : "Your keys, sign-ins and vault are protected only by Cloudflare's encryption. "}
                    To lock them with Atlas's own key too, add a secret named ATLAS_DATA_KEY to your Worker in Cloudflare (Workers, your
                    Atlas, Settings, Variables and Secrets): 32 or more random characters, with a copy kept safe. Atlas locks everything on
                    its next start.
                  </span>
                )}
              </span>
              <span className={sealed.state === "on" && !sealed.unreadable ? "okdot" : "idledot"}>
                {sealed.unreadable ? "Can't read one" : sealed.state === "on" ? "Locked" : "Not locked"}
              </span>
            </div>
            <div className="line" style={{ alignItems: "flex-start", padding: "8px 0" }}>
              <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 500 }}>Take a copy of everything</span>
                <span className="aside">
                  {data.last_export
                    ? `Last taken ${shortDay(data.last_export.at)}, ${size(data.last_export.bytes)}.`
                    : "Everything Atlas keeps, in open formats. Your keys and passwords stay out."}
                </span>
                {data.export_error && <span className="err small">{data.export_error.text}</span>}
                {data.last_export && data.last_export.problems.length > 0 && (
                  <span className="small">
                    {data.last_export.problems.length === 1 ? "One thing" : `${data.last_export.problems.length} things`} couldn't be
                    copied: {data.last_export.problems[0]}
                  </span>
                )}
              </span>
              <a className="btn s" href="/api/export" download>
                Download
              </a>
            </div>
            {data.restore && (
              <div className="line">
                <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 500 }}>Go back in time</span>
                  <span className="aside">
                    {data.restore.restored
                      ? `Went back to ${dayTime(data.restore.restored.to)}, on ${shortDay(data.restore.restored.at)}.`
                      : "To any moment in the last 30 days."}
                  </span>
                </span>
                <button className="btn s" onClick={() => setOpen(open === "back" ? null : "back")}>
                  {open === "back" ? "Close" : "Pick a time"}
                </button>
              </div>
            )}
            {data.delete && (
              <div className="line">
                <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 500 }}>Delete everything</span>
                  <span className="aside">Everything Atlas keeps, for good.</span>
                </span>
                <button className="btn s err" onClick={() => setOpen(open === "delete" ? null : "delete")}>
                  {open === "delete" ? "Close" : "Delete everything"}
                </button>
              </div>
            )}
            <div className="line">
              <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>Setup</span>
                <span className="aside">Pick up any step you skipped.</span>
              </span>
              <button className="btn s" onClick={onSetup}>
                Open setup again
              </button>
            </div>
            <div className="line">
              <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>Signed in here</span>
                <span className="aside">{ended ? "Every device is signed out." : "Everywhere ends every sign-in, this one too."}</span>
              </span>
              <button className="btn s" onClick={onSignOut}>
                Sign out
              </button>
              <button
                className="btn s"
                onClick={() => {
                  atlas.send({ type: "atlas.sessions.end" });
                  setEnded(true);
                  setTimeout(onSignOut, 600);
                }}
              >
                Everywhere
              </button>
            </div>
          </div>
        </div>
      </div>
      {open === "back" && data.restore && <GoBack atlas={atlas} restore={data.restore} />}
      {open === "delete" && data.delete && <DeleteAll atlas={atlas} del={data.delete} />}
      {deleted?.ok && (deleted.detail as { what?: string } | undefined)?.what === "delete" && (
        <Deleted text={deleted.message} left={(deleted.detail as { left: string[] }).left} />
      )}
    </>
  );
}

const size = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** A time as a datetime-local input takes it, in this browser's zone. */
const localInput = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/**
 * Go back in time (§23.4): pick a moment in the last 30 days, see what it
 * means, and hold to confirm. Atlas restarts there. Undo goes back to just
 * before, for the last time it went back.
 */
function GoBack({ atlas, restore }: { atlas: Atlas; restore: NonNullable<SettingsView["data"]["restore"]> }) {
  const [when, setWhen] = useState("");
  const [sent, setSent] = useState(false);
  const at = when ? new Date(when).getTime() : Number.NaN;
  const preview = atlas.state.tests["data.preview"];
  const shown = preview && (preview.detail as { at: number } | undefined)?.at === at ? preview : null;
  const detail = shown?.detail as { lost: string[]; kept: string[] } | undefined;
  const result = atlas.state.tests.data;
  useEffect(() => {
    if (Number.isFinite(at)) atlas.send({ type: "atlas.data.preview", at });
  }, [at]);
  useEffect(() => setSent(false), [result]);
  const go = (msg: { at?: number; undo?: boolean }) => {
    setSent(true);
    atlas.send({ type: "atlas.data.restore", ...msg, hold: true });
  };
  return (
    <div className="card2 pad rise" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="card-head">
        <span className="h2">Go back in time</span>
        <span className="aside">Atlas restarts as it was then.</span>
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        <span>Go back to</span>
        <input
          type="datetime-local"
          value={when}
          min={localInput(restore.earliest)}
          max={localInput(restore.latest)}
          onChange={(e) => setWhen(e.target.value)}
        />
      </label>
      {shown && !shown.ok && <span className="err small">{shown.message}</span>}
      {detail && shown?.ok && (
        <div className="lines solid">
          {detail.lost.map((t) => (
            <span key={t} className="small line" style={{ minHeight: 0, padding: "4px 0" }}>
              {t}
            </span>
          ))}
          {detail.kept.map((t) => (
            <span key={t} className="aside line" style={{ minHeight: 0, padding: "4px 0" }}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <HoldButton label="Hold to go back" disabled={sent || !shown?.ok} onConfirm={() => go({ at })} />
        {restore.restored?.undo && (
          <HoldButton
            label={`Hold to undo going back to ${dayTime(restore.restored.to)}`}
            disabled={sent}
            onConfirm={() => go({ undo: true })}
          />
        )}
      </div>
      {result && (result.detail as { what?: string } | undefined)?.what === "restore" && (
        <span className={result.ok ? "ok small" : "err small"}>{result.message}</span>
      )}
    </div>
  );
}

/**
 * Delete everything (§23.4): what goes and what's left, then the phrase
 * typed and a hold. Only the owner sees it.
 */
function DeleteAll({ atlas, del }: { atlas: Atlas; del: NonNullable<SettingsView["data"]["delete"]> }) {
  const [phrase, setPhrase] = useState("");
  const [sent, setSent] = useState(false);
  const result = atlas.state.tests.data;
  useEffect(() => setSent(false), [result]);
  const typed = phrase.trim().toLowerCase() === del.phrase;
  return (
    <div className="card2 pad rise" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="card-head">
        <span className="h2">Delete everything</span>
        <span className="aside">It can't be undone from here.</span>
      </div>
      <span className="small">
        Everything Atlas keeps goes: your conversations and the log, what it knows about people and places, areas, the agenda, automations,
        pages, skills, Library's files, settings, keys and sign-ins, the vault and your passkeys. The workspace and its copy go too.
        {del.members.length
          ? ` So do your members' Atlases (${del.members.join(", ")}): tell them first, so they can take a copy of theirs.`
          : ""}
      </span>
      <span className="aside">Take a copy first if you want one. Afterwards:</span>
      <div className="lines solid">
        {del.left.map((t) => (
          <span key={t} className="aside line" style={{ minHeight: 0, padding: "4px 0" }}>
            {t}
          </span>
        ))}
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        <span>To delete everything, type "{del.phrase}"</span>
        <input value={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
      </label>
      <div className="row">
        <HoldButton
          label="Hold to delete everything"
          ms={2_000}
          disabled={sent || !typed}
          onConfirm={() => {
            setSent(true);
            atlas.send({ type: "atlas.data.delete", phrase, hold: true });
          }}
        />
      </div>
      {result && !result.ok && (result.detail as { what?: string } | undefined)?.what === "delete" && (
        <span className="err small">{result.message}</span>
      )}
    </div>
  );
}

/** After deleting everything: what's still on Cloudflare, and how to remove it. There's no Atlas to go back to until it's set up again. */
function Deleted({ text, left }: { text: string; left: string[] }) {
  return (
    <div className="card2 pad rise" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="h2">Everything is deleted</span>
      <span className="small">{text}</span>
      <div className="lines solid">
        {left.map((t) => (
          <span key={t} className="small line" style={{ minHeight: 0, padding: "4px 0" }}>
            {t}
          </span>
        ))}
      </div>
      <div className="row">
        <button className="btn s" onClick={() => location.reload()}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Updates (§23.2): which Atlas this is, the newest release and what's in it,
 * Update now and Roll back through Cloudflare's API, and each step's outcome
 * in Cloudflare's own words. The first time, the token they need.
 */
function Updates({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const { at } = useDetail();
  const u = view.updates;
  const note = atlas.state.tests.updates;
  const [token, setToken] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [note]);
  const send = (msg: Parameters<Atlas["send"]>[0]) => {
    setSent(true);
    atlas.send(msg);
  };
  const run = u.run;
  const working = sent || u.busy || run?.state === "running" || run?.state === "deploying";
  const newest = u.newest;
  const running = u.running.version === "unknown" ? "Atlas" : `Atlas ${u.running.version}`;
  return (
    <div className="card2 pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="card-head">
        <span className="h2">Updates</span>
        <span className="aside">
          {u.ready && newest
            ? `${newest.tag} is ready.`
            : `This is ${running}${at("developer") && u.running.version_id ? ` (${u.running.version_id.slice(0, 8)})` : ""}.`}
        </span>
        <span className="grow" />
        <button className="btn s" disabled={working} onClick={() => send({ type: "atlas.updates.look" })}>
          Look now
        </button>
      </div>

      {newest ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <span style={{ fontWeight: 500 }}>{newest.name}</span>
            <span className="aside">Out {shortDay(newest.published_at)}</span>
            {!u.ready && <span className="okdot">You have it</span>}
          </span>
          {newest.notes.trim() ? (
            <div className="small" style={{ maxHeight: 180, overflow: "auto" }}>
              <Markdown text={newest.notes} />
            </div>
          ) : (
            <span className="aside">It came with no notes.</span>
          )}
        </div>
      ) : (
        <p className="muted small">
          {u.looked_at ? "There's no release yet." : "Atlas looks for a new release once a day."}
          {u.looked_at ? ` Looked ${shortDay(u.looked_at)}.` : ""}
        </p>
      )}
      {u.look_error && <span className="err small">Couldn't look: {u.look_error}</span>}

      <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 500 }}>Update on its own</span>
          <span className="aside">
            {view.settings.updates.auto
              ? u.planned
                ? `Installs ${u.planned.tag} around ${dayTime(u.planned.at)}, then tells you what's new.`
                : !u.token
                  ? "It needs the token below first."
                  : "In the night, when a release can go in from here, and then it tells you."
              : "Off: you choose when to update."}
          </span>
        </span>
        <Toggle
          on={view.settings.updates.auto}
          label="Update on its own"
          onChange={(on) => atlas.send({ type: "atlas.settings.update", patch: { updates: { auto: on } } })}
        />
      </div>
      {u.ready && newest?.problem && <span className="small">{newest.problem}</span>}

      {!u.token ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="small">To install from here, Atlas needs a Cloudflare token that can change your Workers.</span>
          <a className="btn s" style={{ alignSelf: "flex-start" }} href={u.token_link} target="_blank" rel="noreferrer">
            Make the token on Cloudflare
          </a>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              aria-label="Your Cloudflare token for updates"
              placeholder="Paste the token"
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btnp s"
              disabled={working || token.trim().length < 8}
              onClick={() => {
                send({ type: "atlas.updates.token", token: token.trim() });
                setToken("");
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          {u.ready && newest && (
            <button
              className="btnp s"
              disabled={working || Boolean(newest.problem)}
              onClick={() => send({ type: "atlas.updates.install", tag: newest.tag })}
            >
              Update now
            </button>
          )}
          {u.rollback && (
            <button className="btn s" disabled={working} onClick={() => send({ type: "atlas.updates.rollback" })}>
              Roll back to {u.rollback.label}
            </button>
          )}
          {run?.needs_force && u.rollback && (
            <button className="btn s err" disabled={working} onClick={() => send({ type: "atlas.updates.rollback", force: true })}>
              Roll back anyway
            </button>
          )}
          <span className="grow" />
          {at("detailed") && u.script && <span className="aside">To your Worker {u.script}</span>}
          <button className="tbtn" disabled={working} onClick={() => send({ type: "atlas.updates.token", token: null })}>
            Forget the token
          </button>
        </div>
      )}

      {run && (
        <div className="lines solid">
          <span className="aside">
            {run.kind === "update" ? `${run.auto ? "Updating on its own" : "Updating"} to ${run.label}` : `Rolling back to ${run.label}`}
            {run.state === "deploying" ? ": restarting on it" : run.state === "done" ? ": done" : run.state === "failed" ? ": stopped" : ""}
            {`, ${shortDay(run.started_at)}`}
          </span>
          {run.steps.map((s, i) => (
            <div className="line" key={i} style={{ alignItems: "flex-start", padding: "4px 0", minHeight: 0 }}>
              <span className={s.ok ? "okdot" : "idledot"} aria-label={s.ok ? "Done" : "Failed"} />
              <span className={`small grow ${s.ok ? "" : "err"}`}>{s.text}</span>
            </div>
          ))}
        </div>
      )}
      {u.foreign && <span className="err small">{u.foreign.text}</span>}
      {note && !note.ok && !run && <span className="err small">{note.message}</span>}
      {note && note.ok && <span className="ok small">{note.message}</span>}
      <span className="aside">Your data stays as it is either way: it only ever grows.</span>
    </div>
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
    <div className="card2 pad rise" style={{ marginTop: 14 }}>
      <div className="card-head">
        <span className="h2">The vault</span>
        <span className="aside">Each one fills only on its own sites.</span>
        <span className="grow" />
        {!open && (
          <button className="btn s" onClick={() => setOpen(true)}>
            Add one
          </button>
        )}
      </div>
      <div className="lines solid">
        {view.vault.map((e) => (
          <div className="line" key={e.id} style={{ alignItems: "flex-start", padding: "8px 0" }}>
            <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span className="row" style={{ gap: 8 }}>
                <span style={{ fontWeight: 500 }}>{e.name}</span>
                <span className="aside">{e.kind === "key" ? "service key" : e.kind}</span>
                <span className="mono aside">{e.sites.join(", ")}</span>
              </span>
              <span className="aside">
                {[...e.fields.map((f) => FIELDS[e.kind][f] ?? f), ...(e.totp ? ["two-factor codes"] : [])].join(" · ")}
                {" · "}
                {e.uses ? `used ${e.uses} ${e.uses === 1 ? "time" : "times"}, last ${shortDay(e.last_used!)}` : "not used yet"}
              </span>
              {e.kind === "card" ? (
                <span className="aside">A card asks every time.</span>
              ) : e.allowed.length ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="aside">Fills without asking on</span>
                  {e.allowed.map((s) => (
                    <span key={s} className="tag">
                      {s}{" "}
                      <button className="tbtn" onClick={() => atlas.send({ type: "atlas.vault.revoke", id: e.id, site: s })}>
                        Ask again
                      </button>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="aside">The first use on each site asks you.</span>
              )}
            </span>
            <button
              className="tbtn"
              onClick={() => {
                setForm({ id: e.id, name: e.name, kind: e.kind, sites: e.sites.join(", "), values: {}, totp: "" });
                setOpen(true);
              }}
            >
              Edit
            </button>
            <button className="tbtn" onClick={() => atlas.send({ type: "atlas.vault.remove", id: e.id })}>
              Remove
            </button>
          </div>
        ))}
        {!view.vault.length && <p className="aside line">Nothing yet. Add a login, and Atlas can sign in for you on that site.</p>}
      </div>
      {open && (
        <form
          className="vault-form"
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
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field grow">
              <span>Name</span>
              <input
                value={form.name}
                maxLength={60}
                placeholder="Chase login"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <Seg
              label="Kind"
              value={form.kind}
              locked={editing}
              options={[
                ["login", "Login"],
                ["card", "Card"],
                ["key", "Key"],
              ]}
              onChange={(kind) => setForm({ ...form, kind, values: {} })}
            />
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
              <span>Two-factor seed, if it has one</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={form.totp}
                placeholder={editing ? "Kept if set. Paste a new one to change it." : "The code the site shows under its QR code"}
                onChange={(e) => setForm({ ...form, totp: e.target.value })}
              />
            </label>
          )}
          <div className="row">
            <button
              className="btnp s"
              disabled={!form.name.trim() || !form.sites.trim() || (!editing && !Object.values(form.values).some((v) => v.trim()))}
            >
              {editing ? "Save" : "Add"}
            </button>
            <button type="button" className="btn s" onClick={close}>
              Cancel
            </button>
            <span className="aside">Neither this page nor Atlas can show the values again.</span>
          </div>
        </form>
      )}
    </div>
  );
}
