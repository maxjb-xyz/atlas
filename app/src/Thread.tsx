import { useEffect, useLayoutEffect, useRef } from "react";
import type { LogRow } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { Mark } from "./Mark";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

export function Thread({ atlas, name }: { atlas: Atlas; name: string }) {
  const { rows, pending, live, loaded, noOlder } = atlas.state;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const asked = useRef<number | null>(null);
  const prevHeight = useRef(0);
  const firstSeq = rows[0]?.seq;

  // Keep the newest message in view unless the owner has scrolled up.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (asked.current !== null && firstSeq !== undefined && firstSeq < asked.current) {
      // Older rows arrived above: hold the reading position.
      el.scrollTop += el.scrollHeight - prevHeight.current;
      asked.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
  });

  useEffect(() => {
    stick.current = true;
  }, [pending.length]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 40 && !noOlder && firstSeq !== undefined && asked.current === null) {
      asked.current = firstSeq;
      atlas.send({ type: "atlas.more", before_seq: firstSeq });
    }
  }

  const liveRuns = Object.entries(live);
  const undone = new Set(rows.filter((r) => r.kind === "agenda.change" && r.body.undo_of).map((r) => String(r.body.undo_of)));
  const empty = loaded && rows.length === 0 && pending.length === 0 && liveRuns.length === 0;

  return (
    <div className="thread" ref={box} onScroll={onScroll}>
      {!loaded && <p className="muted pad">Connecting to {name}.</p>}
      {empty && (
        <div className="hello">
          <Mark size={44} />
          <h2 className="disp">Hi, I'm {name}.</h2>
          <p className="muted">Ask about your calendar, or tell me what to remind you of. Press Space to talk.</p>
        </div>
      )}
      {rows.map((r) => (
        <Row key={r.id} row={r} atlas={atlas} undone={undone.has(r.id)} />
      ))}
      {pending
        .filter((p) => !p.run_id || !rows.some((r) => r.run_id === p.run_id && r.kind === "message.in"))
        .map((p) => (
          <div key={p.client_id} className="msg owner sending">
            <p>{p.text}</p>
          </div>
        ))}
      {liveRuns.map(([runId, l]) => (
        <div key={runId} className="msg atlas live-msg">
          <Mark size={18} />
          <div>
            {l.text && <p>{l.text}</p>}
            {(l.status || !l.text) && <p className="status lab">{l.status ?? "Thinking"}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({ row, atlas, undone }: { row: LogRow; atlas: Atlas; undone: boolean }) {
  const b = row.body as Record<string, unknown>;
  const voiceTag = row.surface === "voice" ? <span className="lab tag">Voice</span> : null;
  switch (row.kind) {
    case "message.in":
      return (
        <div className="msg owner">
          <p>{str(b.text)}</p>
          <span className="lab when">
            {voiceTag}
            {time(row.at)}
          </span>
        </div>
      );
    case "message.out":
      return (
        <div className="msg atlas">
          <Mark size={18} />
          <div>
            <p>{str(b.text)}</p>
            <span className="lab when">
              {voiceTag}
              {b.interrupted ? <span className="tag">Interrupted</span> : null}
              <Timing timing={b.timing} />
              {time(row.at)}
            </span>
          </div>
        </div>
      );
    case "tool.result": {
      const receipt = b.receipt as { text: string; undo?: unknown } | undefined;
      if (!receipt) return null;
      return (
        <div className={`receipt ${b.ok === false ? "bad" : ""}`}>
          <span className="tick" aria-hidden>
            {b.ok === false ? "×" : "✓"}
          </span>
          <span>{receipt.text}</span>
          {undone && <span className="lab">Undone</span>}
          {receipt.undo != null && !undone && (
            <button className="link" onClick={() => atlas.send({ type: "atlas.undo", log_id: row.id })}>
              Undo
            </button>
          )}
        </div>
      );
    }
    case "voice.problem":
      return <p className="note fail">{str(b.message)}</p>;
    case "brain.fallback":
      return (
        <p className="note">
          Answered by {str(b.to)} because {str(b.from)}: {str(b.reason)}
        </p>
      );
    case "agenda.change":
      return <p className="note">You undid it: {str(b.title)}. Atlas won't remind you.</p>;
    case "run.end":
      return <p className="note fail">Didn't finish. {str(b.error) || "The run failed."}</p>;
    default:
      return null;
  }
}

const secs = (ms: unknown) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : null);

/** For spoken replies: when the status line and the answer were ready after you stopped talking. */
function Timing({ timing }: { timing: unknown }) {
  if (!timing || typeof timing !== "object") return null;
  const t = timing as { status_ms?: unknown; answer_ms?: unknown };
  const parts = [secs(t.status_ms) && `status ${secs(t.status_ms)}`, secs(t.answer_ms) && `answer ${secs(t.answer_ms)}`].filter(Boolean);
  return parts.length ? <span className="tag">{parts.join(" · ")}</span> : null;
}
