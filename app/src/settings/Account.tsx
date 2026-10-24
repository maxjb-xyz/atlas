// Atlas settings → Account (docs/ui §8): how you sign in (passkeys), your
// passwords and cards (the vault, §15), updates, and your data: whether
// Atlas's own key locks your secrets (§20), setup, and signing out.

import { useState } from "react";
import type { SettingsView } from "../../../core/src/protocol";
import { FIELDS, type VaultKind } from "../../../core/src/vault-fields";
import type { Atlas } from "../connection";
import { useDetail } from "../theme";
import { Icon, LogoMark, Seg, shortDay } from "../ui";
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
  const sealed = view.secrets.sealed;
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
        <div className="card2 pad">
          <div className="card-head">
            <span className="h2">Updates</span>
            <span className="aside">{at("developer") ? `This is Atlas ${__ATLAS_VERSION__}.` : "Atlas, as you deployed it."}</span>
          </div>
          {/* TODO(core, stage 2): releases from the daily look, "Update now" and "Roll back" through Cloudflare's API, and updating on its own. */}
          <p className="muted small">
            When a new Atlas is out, it shows here with what changed, to install in one click. Until then, updates come from your copy of
            the repository.
          </p>
        </div>

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
            {/* TODO(core): "Take a copy of everything", "Go back in time" and "Delete everything" (docs/ui §8) once export and point-in-time restore exist. */}
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
