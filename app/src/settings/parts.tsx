// Parts the settings sections, Abilities and People share: a section's head,
// a labelled line, live tests (§22: every check is a live test), a secret's
// field, ChatGPT's sign-in, adding a passkey, and a list of the owner's words.

import { type ReactNode, useEffect, useState } from "react";
import type { ChatGPTView } from "../../../core/src/protocol";
import type { Atlas, TestResult } from "../connection";
import { addPasskey, deviceName, passkeysSupported } from "../passkey";
import { Icon } from "../ui";

/** A section's title, its one line, and what goes on the right. */
export function Head({ title, sub, right }: { title: string; sub: string; right?: ReactNode }) {
  return (
    <div className="set-head">
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <h1 className="disp">{title}</h1>
        <p className="muted">{sub}</p>
      </div>
      <span className="grow" />
      {right}
    </div>
  );
}

/** One setting: its name (and at most one short line under it) on the left, the control on the right. */
export function Line({ label, sub, children, center }: { label: string; sub?: string; children: ReactNode; center?: boolean }) {
  return (
    <div className={`set-line ${center ? "mid" : ""}`}>
      <div className="set-label">
        <span>{label}</span>
        {sub && <span className="aside">{sub}</span>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

export function TestRow({ label, k, atlas, run, hint }: { label: string; k: string; atlas: Atlas; run: () => void; hint?: string }) {
  const r = atlas.state.tests[k];
  const waiting = atlas.state.testKeys[k.split(":")[0]!] === k && !r;
  const [ran, setRan] = useState(false);
  return (
    <div className="row" title={hint}>
      <button
        className="btn s"
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

export function TestMessage({ r }: { r: TestResult }) {
  return <span className={`small ${r.ok ? "ok" : "err"}`}>{r.message}</span>;
}

/** A secret's field: it goes in and never comes back out; the page only knows whether it's set. */
export function SecretField({ label, set, onSave }: { label: string; set: boolean; onSave: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row" style={{ flexWrap: "nowrap" }}>
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
          className="btn s"
          disabled={value.length < 8}
          onClick={() => {
            onSave(value);
            setValue("");
          }}
        >
          Save
        </button>
        {set && (
          <button type="button" className="btn s" onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
    </label>
  );
}

/** "Sign in with ChatGPT": open the sign-in, then paste the address the browser landed on. */
export function ChatGPTSignIn({ chatgpt, atlas }: { chatgpt: ChatGPTView; atlas: Atlas }) {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="row">
        {chatgpt.state === "signed_in" && (
          <button className="btn s" onClick={() => atlas.send({ type: "atlas.chatgpt.signout" })}>
            Sign out
          </button>
        )}
        {(chatgpt.state === "signed_out" || chatgpt.state === "error") && (
          <button className="btnp s" onClick={() => atlas.send({ type: "atlas.chatgpt.start" })}>
            Sign in with ChatGPT
          </button>
        )}
        {chatgpt.state === "pending" && (
          <button className="tbtn" onClick={() => atlas.send({ type: "atlas.chatgpt.cancel" })}>
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
            <button className="btn s" type="submit" disabled={!landed.trim()}>
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

/**
 * Adds a passkey on this device. If Atlas asks for the setup code first
 * (a passkey exists and this sign-in isn't recent), it asks for it here.
 */
export function AddPasskey({ label = "Add a passkey on this device" }: { label?: string }) {
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
  if (!passkeysSupported()) return <span className="aside">This browser can't make passkeys.</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      {askCode && (
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Setup code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && code && void add()}
          style={{ width: 200 }}
        />
      )}
      <button className="btn s" disabled={busy || (askCode && !code)} onClick={() => void add()}>
        {busy ? "Waiting for your device" : label}
      </button>
      {msg && <span className={`small ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
    </div>
  );
}

/** A list of the owner's own words, with a × on each and a field to add one. */
export function Words(o: { label: string; empty: string; placeholder: string; list: string[]; set: (list: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const add = () => {
    const t = adding.trim();
    if (t && !o.list.some((q) => q.toLowerCase() === t.toLowerCase())) o.set([...o.list, t]);
    setAdding("");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="small" style={{ fontWeight: 500 }}>
        {o.label}
      </span>
      {o.list.length ? (
        <div className="row" style={{ gap: 6 }}>
          {o.list.map((q) => (
            <button key={q} className="word" title="Take this off the list" onClick={() => o.set(o.list.filter((x) => x !== q))}>
              {q}
              <Icon name="x" size={11} />
            </button>
          ))}
        </div>
      ) : (
        <span className="aside">{o.empty}</span>
      )}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input
          aria-label={o.label}
          placeholder={o.placeholder}
          value={adding}
          maxLength={120}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn s" onClick={add} disabled={!adding.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

/** A file picked from disk as base64, for small uploads over the socket (an area's logo). */
export async function fileBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
