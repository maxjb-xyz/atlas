// The full transcript (⌘J): every message, receipt and note, from the log.
// Messages carry their area chip; tapping it moves the message (§6.3).

import { useEffect, useLayoutEffect, useRef } from "react";
import type { LogRow } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { Receipt } from "./Shell";
import { openOnStage, shownFrom, StageCard } from "./StageViews";
import { Markdown } from "./Markdown";
import { AreaChip, Diamond, clock } from "./ui";

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
  const undone = new Set(rows.filter((r) => r.body.undo_of).map((r) => String(r.body.undo_of)));
  const empty = loaded && rows.length === 0 && pending.length === 0 && liveRuns.length === 0;

  return (
    <div className="thread" ref={box} onScroll={onScroll}>
      {!loaded && <p className="muted">Connecting to {name}.</p>}
      {empty && <p className="muted">Nothing said yet. Ask about your calendar, tell me something to remember, or press Space to talk.</p>}
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
        <div key={runId} className="msg atlas">
          <Diamond size={16} />
          <div>
            {l.text && <Markdown text={l.text} />}
            {(l.status || !l.text) && <p className="lab">{l.status ?? "Thinking"}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({ row, atlas, undone }: { row: LogRow; atlas: Atlas; undone: boolean }) {
  const b = row.body as Record<string, unknown>;
  const s = atlas.state;
  const voiceTag = row.surface === "voice" ? <span className="tag">Voice</span> : null;
  const chip = (
    <AreaChip ids={row.areas} areas={s.areas} onMove={(ids) => atlas.send({ type: "atlas.areas.set", ref: `log:${row.id}`, areas: ids })} />
  );
  switch (row.kind) {
    case "message.in":
      return (
        <div className="msg owner">
          <p>{str(b.text)}</p>
          <span className="lab when">
            {voiceTag}
            {s.areas.length > 0 && chip}
            {clock(row.at)}
          </span>
        </div>
      );
    case "message.out":
      return (
        <div className="msg atlas">
          <Diamond size={16} />
          <div>
            <Markdown text={str(b.text)} />
            <span className="lab when">
              {voiceTag}
              {b.interrupted ? <span className="tag">Interrupted</span> : null}
              <Timing timing={b.timing} />
              {clock(row.at)}
            </span>
          </div>
        </div>
      );
    case "tool.result": {
      const shown = shownFrom(row);
      if (shown) return <StageCard atlas={atlas} shown={shown} onOpen={() => openOnStage(shown.id)} />;
      return (
        <div className="note">
          <Receipt row={row} atlas={atlas} undone={undone} />
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
      if (b.kind === "approval") {
        const results = Array.isArray(b.results) ? b.results.map(String).join(" ") : "";
        return (
          <p className={`note ${b.change === "done" && b.ok === false ? "fail" : ""}`}>
            {b.change === "done"
              ? `You OK'd ${str(b.title)}${b.edited ? " with your edits" : ""}. ${results}`
              : b.change === "cancelled"
                ? `You declined ${str(b.title)}, so nothing was done.`
                : `Your OK for ${str(b.title)} ran out, so it didn't happen.`}
          </p>
        );
      }
      return <p className="note">You undid it: {str(b.title)}. Atlas won't remind you.</p>;
    case "record.change":
      return (
        <p className="note">
          You undid it.{" "}
          {b.change === "forgotten"
            ? `Atlas forgot: ${str(b.name)}.`
            : b.change === "restored"
              ? `Atlas remembers ${str(b.name)} again.`
              : `${str(b.name)} is back to what it was.`}
        </p>
      );
    case "area.change":
      return (
        <p className="note">
          Atlas started an area: <strong>{str(b.name)}</strong>, from {str(b.from)} conversations about it.{" "}
          <button className="link" onClick={() => atlas.send({ type: "atlas.area.update", id: str(b.area_id), state: "archived" })}>
            Not an area
          </button>
        </p>
      );
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
  const t = timing as { status_ms?: unknown; answer_ms?: unknown; tools?: unknown };
  const tools = Array.isArray(t.tools) ? t.tools.map(String) : null;
  const parts = [
    secs(t.status_ms) && `status ${secs(t.status_ms)}`,
    secs(t.answer_ms) && `answer ${secs(t.answer_ms)}`,
    tools && (tools.length ? tools.join(", ") : "no lookup"),
  ].filter(Boolean);
  return parts.length ? <span className="tag">{parts.join(" · ")}</span> : null;
}
