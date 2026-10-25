// The conversation (§21.1): Home is the whole thread, text and voice alike.
// Atlas's words with the receipts for what it did under them, the owner's
// words, approvals waiting for an OK, each job as a card under the message
// that asked for it, and a job's questions and result as messages with their
// buttons and files. The composer sits at the bottom, with what needs the
// owner just above it. Messages carry their area chip; tapping it moves the
// message (§6.3).

import { useEffect, useLayoutEffect, useRef } from "react";
import type { InboxItem, JobView, LogRow } from "../../core/src/protocol";
import { ApprovalCard } from "./Approval";
import type { Atlas, Live, Pending } from "./connection";
import { isOpen, JobCard, questionFromRow, QuestionBody, ResultBody } from "./JobViews";
import { InlineText, Markdown } from "./Markdown";
import { Composer, Receipt, VoiceStrip } from "./Shell";
import { type Shown, shownFrom, StageCard } from "./StageViews";
import { useDetail } from "./theme";
import { AreaChip, AsciiDiamond, clock, Diamond, Icon, startOfDay } from "./ui";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** What opens from the conversation: a view on the stage, a job's thread, a receipt's detail, Now and the week, Inbox. */
export interface Opens {
  view: (s: Shown) => void;
  job: (j: JobView) => void;
  receipt: (r: LogRow) => void;
  now: () => void;
  week: () => void;
  inbox: () => void;
}

type Item =
  | { k: "row"; row: LogRow; receipts: LogRow[]; run: string | null; at: number }
  | { k: "receipts"; rows: LogRow[]; run: string | null; at: number }
  | { k: "live"; live: Live; receipts: LogRow[]; run: string; at: number }
  | { k: "job"; job: JobView; run: string | null; at: number }
  | { k: "pending"; p: Pending; run: null; at: number };

/** Whether a row is a message in the conversation. A job's updates aren't: they're on its card and in its own thread. */
function shows(r: LogRow): boolean {
  switch (r.kind) {
    case "message.in":
    case "message.out":
    case "voice.problem":
    case "brain.fallback":
    case "agenda.change":
    case "record.change":
    case "area.change":
    case "run.end":
    case "job.question":
      return true;
    case "tool.result":
      return r.body.receipt != null;
    case "job.result":
      return Array.isArray(r.body.files) && r.body.of == null;
    default:
      return false;
  }
}

/** The thread, in order: messages with their receipts, what's being said now, and each job's card where it was asked for. */
function arrange(rows: LogRow[], live: Record<string, Live>, jobs: JobView[], pending: Pending[]): Item[] {
  const visible = rows.filter(shows);
  const lastOut = new Map<string, string>();
  for (const r of visible) if (r.kind === "message.out" && r.run_id) lastOut.set(r.run_id, r.id);
  // Receipts sit under the message of the run that made them, or under what it's saying now.
  const sits = (run: string | null) => run != null && (lastOut.has(run) || live[run] != null);
  const receipts = new Map<string, LogRow[]>();
  for (const r of visible) if (r.kind === "tool.result" && sits(r.run_id)) receipts.set(r.run_id!, [...(receipts.get(r.run_id!) ?? []), r]);
  const items: Item[] = [];
  for (const r of visible) {
    if (r.kind === "tool.result") {
      if (sits(r.run_id)) continue;
      const prev = items.at(-1);
      if (prev?.k === "receipts" && prev.run === r.run_id) prev.rows.push(r);
      else items.push({ k: "receipts", rows: [r], run: r.run_id, at: r.at });
      continue;
    }
    const mine = r.kind === "message.out" && r.run_id && lastOut.get(r.run_id) === r.id ? (receipts.get(r.run_id) ?? []) : [];
    items.push({ k: "row", row: r, receipts: mine, run: r.run_id, at: r.at });
  }
  const after = (run: string | null, item: Item): boolean => {
    if (!run) return false;
    let at = -1;
    items.forEach((it, i) => {
      if (it.run === run) at = i;
    });
    if (at < 0) return false;
    items.splice(at + 1, 0, item);
    return true;
  };
  const byTime = (item: Item) => {
    const i = items.findIndex((it) => it.k !== "pending" && it.at > item.at);
    if (i < 0) items.push(item);
    else items.splice(i, 0, item);
  };
  for (const [run, l] of Object.entries(live)) {
    const item: Item = { k: "live", live: l, receipts: lastOut.has(run) ? [] : (receipts.get(run) ?? []), run, at: Date.now() };
    if (!after(run, item)) items.push(item);
  }
  for (const job of [...jobs].sort((a, b) => a.started_at - b.started_at)) {
    const asked = job.owned?.asked_by ?? rows.find((r) => r.kind === "message.in" && r.run_id != null && r.run_id === job.run_id)?.id;
    const anchor = asked ? items.find((it) => it.k === "row" && it.row.id === asked) : undefined;
    const item: Item = { k: "job", job, run: anchor?.run ?? null, at: anchor?.at ?? job.started_at };
    if (anchor && anchor.run && after(anchor.run, item)) continue;
    if (anchor) items.splice(items.indexOf(anchor) + 1, 0, item);
    else byTime(item);
  }
  for (const p of pending.filter((p) => !p.run_id || !rows.some((r) => r.run_id === p.run_id && r.kind === "message.in")))
    items.push({ k: "pending", p, run: null, at: p.at });
  return items;
}

function dayLabel(at: number): string {
  const d = startOfDay(new Date(at)).getTime();
  const today = startOfDay(new Date()).getTime();
  if (d === today) return "Today";
  if (d === today - 86_400_000) return "Yesterday";
  return new Date(at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

/** The first thing waiting on the owner, in a few words, for the strip above the composer. */
function needLine(i: InboxItem): string {
  if (i.job) return i.job.question;
  return i.title;
}

/**
 * Home's conversation: the whole thread, scrolled to its newest message, with
 * the voice strip, what needs you, and the composer under it. `focus` is a
 * row (or an approval) to show where it was asked, from Inbox.
 */
export function Conversation({
  atlas,
  opens,
  focus,
  onFocused,
}: {
  atlas: Atlas;
  opens: Opens;
  focus?: string | null;
  onFocused?: () => void;
}) {
  const s = atlas.state;
  const { rows, pending, live, loaded, noOlder } = s;
  const name = s.view?.settings.assistant_name ?? "Atlas";
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const asked = useRef<number | null>(null);
  const prevHeight = useRef(0);
  const firstSeq = rows[0]?.seq;

  // Keep the newest message in view unless the owner has scrolled up; older messages load in above without a jump.
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

  // Keeps to the bottom as the thread's box changes size (the stage opening beside it, the window, the phone's keyboard).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const o = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    o.observe(el);
    return () => o.disconnect();
  }, []);

  function older() {
    if (noOlder || firstSeq === undefined || asked.current !== null) return;
    asked.current = firstSeq;
    atlas.send({ type: "atlas.more", before_seq: firstSeq });
  }

  function onScroll() {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 40) older();
  }

  // Shown where it was asked (from Inbox): scrolled to and lit for a moment, reading back until it's found.
  useEffect(() => {
    if (!focus || !loaded) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(focus)}"], [data-approval="${CSS.escape(focus)}"]`);
    if (el) {
      stick.current = false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("lit");
      void el.offsetWidth;
      el.classList.add("lit");
      onFocused?.();
    } else if (!noOlder) older();
    else onFocused?.();
  }, [focus, loaded, rows, noOlder]);

  const undone = new Set(rows.filter((r) => r.body.undo_of).map((r) => String(r.body.undo_of)));
  const items = arrange(rows, live, s.jobs, pending);
  const empty = loaded && items.length === 0;
  const owner = s.view?.settings.owner_name?.split(" ")[0];
  let day = "";

  return (
    <div className="sheet convo">
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <div className="thread" ref={box} onScroll={onScroll}>
        <div className="thread-col">
          {!loaded && <p className="faint thread-hint">Connecting to {name}.</p>}
          {loaded && noOlder && items.length > 0 && <p className="faint thread-hint">The start of your conversation with {name}.</p>}
          {empty && (
            <div className="thread-empty rise">
              <AsciiDiamond height={132} />
              <h1 className="disp">
                {greeting(new Date())}
                {owner ? `, ${owner}` : ""}.
              </h1>
              <p className="muted">Ask me anything, tell me something to remember, or press Space to talk.</p>
              <p className="row" style={{ gap: 16, justifyContent: "center" }}>
                <button className="link" onClick={opens.now}>
                  What's on now
                </button>
                <button className="link" onClick={opens.week}>
                  Your week
                </button>
              </p>
            </div>
          )}
          {items.map((it) => {
            const label = dayLabel(it.at);
            const sep = label !== day;
            day = label;
            const key =
              it.k === "row"
                ? it.row.id
                : it.k === "receipts"
                  ? it.rows[0]!.id
                  : it.k === "live"
                    ? `live:${it.run}`
                    : it.k === "job"
                      ? `job:${it.job.id}`
                      : it.p.client_id;
            return (
              <div key={key} className="item">
                {sep && (
                  <div className="day">
                    <span>{label}</span>
                  </div>
                )}
                <ItemView atlas={atlas} item={it} undone={undone} opens={opens} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="convo-dock">
        {atlas.inCall && <VoiceStrip atlas={atlas} />}
        <NeedsYou atlas={atlas} onOpen={opens.inbox} />
        <Composer atlas={atlas} placeholder={`Message ${name}`} reply={false} />
      </div>
    </div>
  );
}

/** What waits on the owner, in one slim line above the composer (§21.1): it opens Inbox. */
function NeedsYou({ atlas, onOpen }: { atlas: Atlas; onOpen: () => void }) {
  // An answer sent from here leaves the strip at once, before Inbox catches up.
  const all = (atlas.state.inbox ?? []).filter((i) => !atlas.state.answered[i.id]);
  if (!all.length) return null;
  const deciding = all.filter((i) => i.kind === "approval" || i.kind === "question");
  const first = deciding[0] ?? all[0]!;
  return (
    <button className="needs-strip rise" onClick={onOpen}>
      <span className="sq-ac" aria-hidden />
      <span className="ns-label">Needs you</span>
      <span className="clip grow">{needLine(first)}</span>
      {all.length > 1 && <span className="faint ns-more">{all.length - 1} more</span>}
      <Icon name="right" size={13} />
    </button>
  );
}

function ItemView({ atlas, item, undone, opens }: { atlas: Atlas; item: Item; undone: Set<string>; opens: Opens }) {
  switch (item.k) {
    case "row":
      return <Row atlas={atlas} row={item.row} receipts={item.receipts} undone={undone} opens={opens} />;
    case "receipts":
      return (
        <div className="msg atlas" data-row={item.rows[0]!.id}>
          <span className="mark" />
          <div className="body">
            <Receipts atlas={atlas} rows={item.rows} undone={undone} opens={opens} />
          </div>
        </div>
      );
    case "live":
      return (
        <div className="msg atlas">
          <span className="mark">
            <Diamond size={14} />
          </span>
          <div className="body">
            {item.live.text && <Markdown className="said" text={item.live.text} />}
            {(item.live.status || !item.live.text) && (
              <p className="thinking">
                <span className="mono spin" aria-hidden />
                {item.live.status ?? "Thinking"}
              </p>
            )}
            {item.receipts.length > 0 && <Receipts atlas={atlas} rows={item.receipts} undone={undone} opens={opens} />}
          </div>
        </div>
      );
    case "job":
      return (
        <div className="msg atlas job" data-job={item.job.id}>
          <span className="mark" />
          <div className="body">
            <JobCard atlas={atlas} job={item.job} onOpen={() => opens.job(item.job)} />
          </div>
        </div>
      );
    case "pending":
      return (
        <div className="msg owner sending">
          <p className="bubble">{item.p.text}</p>
        </div>
      );
  }
}

/** The receipts for what Atlas did, under its message: views it showed as cards, approvals waiting as their card, the rest as chips. */
function Receipts({ atlas, rows, undone, opens }: { atlas: Atlas; rows: LogRow[]; undone: Set<string>; opens: Opens }) {
  const inbox = atlas.state.inbox ?? [];
  const shown = rows.map((r) => [r, shownFrom(r)] as const);
  const chips = shown.filter(([, v]) => !v).map(([r]) => r);
  const cards = shown.filter((x): x is readonly [LogRow, Shown] => x[1] != null);
  const waiting = chips
    .map((r) => {
      const id = (r.body.receipt as { approval?: string } | undefined)?.approval;
      const item = id ? inbox.find((i) => i.id === id && i.approval) : undefined;
      return item ? ([r, item] as const) : null;
    })
    .filter((x) => x != null);
  return (
    <>
      {chips.length > 0 && (
        <div className="receipts">
          {chips.map((r) => (
            <span key={r.id} data-row={r.id} data-approval={(r.body.receipt as { approval?: string } | undefined)?.approval}>
              <Receipt row={r} atlas={atlas} undone={undone.has(r.id)} onOpen={() => opens.receipt(r)} />
            </span>
          ))}
        </div>
      )}
      {waiting.map(([r, item]) => (
        <div key={`ok:${r.id}`} className="approval-inline rise" data-approval={item.id}>
          <span className="q-for">
            <span className="sq-ac" aria-hidden />
            {item.title} needs your OK
          </span>
          <ApprovalCard atlas={atlas} a={item.approval!} />
        </div>
      ))}
      {cards.map(([r, v]) => (
        <div key={r.id} data-row={r.id}>
          <StageCard atlas={atlas} shown={v} onOpen={() => opens.view(v)} />
        </div>
      ))}
    </>
  );
}

function Row({
  atlas,
  row,
  receipts,
  undone,
  opens,
}: {
  atlas: Atlas;
  row: LogRow;
  receipts: LogRow[];
  undone: Set<string>;
  opens: Opens;
}) {
  const b = row.body as Record<string, unknown>;
  const s = atlas.state;
  const { at } = useDetail();
  const voiceTag =
    row.surface === "voice" ? (
      <span className="voice-tag" title="Said out loud">
        <Icon name="mic" size={11} /> Voice
      </span>
    ) : null;
  switch (row.kind) {
    case "message.in": {
      const chip = (
        <AreaChip
          ids={row.areas}
          areas={s.areas}
          onMove={(ids) => atlas.send({ type: "atlas.areas.set", ref: `log:${row.id}`, areas: ids })}
        />
      );
      return (
        <div className="msg owner" data-row={row.id}>
          <p className="bubble">{str(b.text)}</p>
          <span className={`when ${row.areas.length || row.surface === "voice" ? "keep" : ""}`}>
            {voiceTag}
            {s.areas.length > 0 && chip}
            <span>{clock(row.at)}</span>
          </span>
        </div>
      );
    }
    case "message.out":
      return (
        <div className="msg atlas" data-row={row.id}>
          <span className="mark">
            <Diamond size={14} />
          </span>
          <div className="body">
            <Markdown className="said" text={str(b.text)} />
            {receipts.length > 0 && <Receipts atlas={atlas} rows={receipts} undone={undone} opens={opens} />}
            <span className={`when ${row.surface === "voice" || b.interrupted ? "keep" : ""}`}>
              {voiceTag}
              {b.interrupted ? <span>Interrupted</span> : null}
              {at("developer") && <Timing timing={b.timing} />}
              <span>{clock(row.at)}</span>
            </span>
          </div>
        </div>
      );
    case "job.question":
      return (
        <div className="msg atlas" data-row={row.id}>
          <span className="mark">
            <Diamond size={14} />
          </span>
          <div className="body">
            <QuestionBody atlas={atlas} q={questionFromRow(row)} open={isOpen(atlas, row.id)} />
            <span className="when">
              <span>{clock(row.at)}</span>
            </span>
          </div>
        </div>
      );
    case "job.result":
      return (
        <div className="msg atlas" data-row={row.id}>
          <span className="mark">
            <Diamond size={14} />
          </span>
          <div className="body">
            <ResultBody row={row} />
            <span className="when">
              <span>{clock(row.at)}</span>
            </span>
          </div>
        </div>
      );
    case "voice.problem":
      return (
        <p className="note fail" data-row={row.id}>
          {str(b.message)}
        </p>
      );
    case "brain.fallback":
      return (
        <p className="note" data-row={row.id}>
          Answered by {str(b.to)} because {str(b.from)}: {str(b.reason)}
        </p>
      );
    case "agenda.change":
      if (b.kind === "approval") {
        const results = Array.isArray(b.results) ? b.results.map(String).join(" ") : "";
        return (
          <p className={`note wrap-anywhere ${b.change === "done" && b.ok === false ? "fail" : ""}`} data-row={row.id}>
            {b.change === "done" ? (
              <InlineText text={`You OK'd ${str(b.title)}${b.edited ? " with your edits" : ""}. ${results}`} />
            ) : b.change === "cancelled" ? (
              `You declined ${str(b.title)}, so nothing was done.`
            ) : (
              `Your OK for ${str(b.title)} ran out, so it didn't happen.`
            )}
          </p>
        );
      }
      return (
        <p className="note" data-row={row.id}>
          You undid it: {str(b.title)}. {b.kind === "promise" ? "I won't do it." : "I won't remind you."}
        </p>
      );
    case "record.change":
      return (
        <p className="note" data-row={row.id}>
          You undid it.{" "}
          {b.change === "forgotten"
            ? `I forgot ${str(b.name)}.`
            : b.change === "restored"
              ? `I remember ${str(b.name)} again.`
              : `${str(b.name)} is back to what it was.`}
        </p>
      );
    case "area.change":
      return (
        <p className="note" data-row={row.id}>
          I started an area: <strong>{str(b.name)}</strong>, from {str(b.from)} conversations about it.{" "}
          <button className="link" onClick={() => atlas.send({ type: "atlas.area.update", id: str(b.area_id), state: "archived" })}>
            Not an area
          </button>
        </p>
      );
    case "run.end":
      if (b.interrupted)
        return (
          <p className="note" data-row={row.id}>
            Stopped.
          </p>
        );
      return (
        <p className="note fail" data-row={row.id}>
          I didn't finish. {str(b.error) || "The run failed."}
        </p>
      );
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
  return parts.length ? <span className="mono">{parts.join(" · ")}</span> : null;
}
