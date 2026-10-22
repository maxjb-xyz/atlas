// The approval card (VISION §12.2): one card for the whole plan, with every
// step, why it needs the owner's OK, the checks it passed, and how long it
// waits. Edits in the card are what go out. What can't be undone takes hold
// to confirm. Shown in Inbox and, when it arrives, on Home's stage.

import { useEffect, useRef, useState } from "react";
import type { ApprovalView } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { useNow } from "./ui";

const left = (ms: number) => {
  if (ms <= 0) return "running out";
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h} h ${m} min left` : `${h} h left`) : `${m} min left`;
};

export function ApprovalCard({ atlas, a }: { atlas: Atlas; a: ApprovalView }) {
  const now = useNow(30_000);
  const [messages, setMessages] = useState(a.steps.map((s) => s.message ?? ""));
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [a.id]);
  const edits = a.steps
    .map((s, index) => ({ index, message: messages[index] ?? "", was: s.message }))
    .filter((e) => e.was != null && e.message !== e.was)
    .map(({ index, message }) => ({ index, message }));
  const decide = (yes: boolean, hold = false) => {
    setBusy(true);
    atlas.send({ type: "atlas.approval.decide", id: a.id, yes, ...(hold ? { hold: true } : {}), ...(edits.length ? { edits } : {}) });
  };

  return (
    <div className="approval">
      {a.asked && <p className="muted small">You asked: “{a.asked}”</p>}
      <div className="rows">
        {a.steps.map((s, i) => (
          <div className="r" key={i} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              {a.steps.length > 1 && <span className="mono faint">{String(i + 1).padStart(2, "0")}</span>}
              <span style={{ fontWeight: 500 }} className="grow">
                {s.title}
              </span>
              <span className={`tag ${s.kind !== "webhook" ? "ac" : ""}`}>
                {s.kind === "delete"
                  ? "Can't be undone"
                  : s.kind === "browser"
                    ? "Sends a form"
                    : s.kind === "vault"
                      ? "Uses the vault"
                      : s.kind === "site"
                        ? "Opens a website to the workspace"
                        : "Reaches outside"}
              </span>
            </div>
            <p className="small">{s.detail}</p>
            <p className="lab faint">{s.where}</p>
            {s.message != null && (
              <label className="field">
                <span>Message it sends{messages[i] !== s.message ? " · edited" : ""}</span>
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={messages[i]}
                  placeholder="Nothing: it sends its name"
                  onChange={(e) => setMessages(messages.map((m, j) => (j === i ? e.target.value : m)))}
                />
              </label>
            )}
            <p className="faint small">{s.undo}</p>
          </div>
        ))}
      </div>
      <p className="small" style={{ marginTop: 10 }}>
        <span className="lab">Why it asks</span> {a.why}
      </p>
      <div className="row" style={{ marginTop: 10, gap: 12 }}>
        <div className="chain">
          {a.checks.map((c, i) => (
            <span key={c.name} style={{ display: "contents" }}>
              {i > 0 && <span className="dash" />}
              <span className={`tag ${c.name === "Your OK" ? "ac" : c.ok ? "ok" : "ac"}`}>
                {c.name === "Your OK" ? "" : c.ok ? "✓ " : "× "}
                {c.name}
              </span>
            </span>
          ))}
        </div>
        <span className="grow" />
        <span className="mono faint small">{left(a.expires_at - now)}</span>
      </div>
      {!a.checks.every((c) => c.ok || c.name === "Your OK") && (
        <p className="err small">A message holds one of your secrets, so that step won't go out. Edit it first.</p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        {a.hold ? (
          <HoldButton
            label={a.steps.length > 1 ? "Hold to do all of it" : "Hold to confirm"}
            disabled={busy}
            onConfirm={() => decide(true, true)}
          />
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => decide(true)}>
            {edits.length ? "Approve with my edits" : "Approve"}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => decide(false)}>
          Decline
        </button>
      </div>
    </div>
  );
}

/** Hold to confirm (§21.8): a bar fills while held; letting go early does nothing. Works with a pointer, Enter or Space. */
export function HoldButton({
  label,
  onConfirm,
  disabled,
  ms = 1200,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  ms?: number;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, ms);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => stop, []);
  return (
    <button
      className={`btn primary hold ${holding ? "on" : ""}`}
      disabled={disabled}
      style={{ ["--hold" as string]: `${ms}ms` }}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="fill" aria-hidden />
      <span className="label">{holding ? "Keep holding" : label}</span>
    </button>
  );
}
