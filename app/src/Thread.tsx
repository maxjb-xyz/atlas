// The conversation (§21.1): Home is the whole thread, text and voice alike.
// Each day opens with Atlas's presence: the living diamond, a greeting, and
// what matters now. Then Atlas's words with the receipts for what it did under
// them, the owner's words, approvals waiting for an OK, each job as a live card
// under the message that asked for it, and a job's questions and result as
// messages with their buttons and files. The composer sits at the bottom, with
// what needs the owner just above it. Messages carry their area chip; tapping
// it moves the message (§6.3).

import { useEffect, useLayoutEffect, useRef } from "react";
import type { InboxItem, JobView, LogRow } from "../../core/src/protocol";
import { ApprovalCard } from "./Approval";
import type { Atlas, Live, Pending } from "./connection";
import { isOpen, JobCard, questionFromRow, QuestionBody, ResultBody, topJobs } from "./JobViews";
import { jobNow } from "./jobs";
import { InlineText, Markdown } from "./Markdown";
import { eventEnd, eventStart, useCalendar } from "./pages/Week";
import { Composer, Receipt, VoiceStrip } from "./Shell";
import { type Shown, shownFrom, StageCard } from "./StageViews";
import { useDetail } from "./theme";
import {
  addDays,
  AreaChip,
  AsciiDiamond,
  clock,
  CountUp,
  type DiamondState,
  elapsed,
  Icon,
  LiveMark,
  morphOrigin,
  startOfDay,
  useNow,
} from "./ui";

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
  // A job's own rows (the owner's words and answers to it, what its turns did) are its thread's, not the main one (§21.4).
  if ((r.kind === "message.in" || r.kind === "tool.result") && r.body.job != null) return false;
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
  // A job's turn streams in its own thread (§21.4), not here.
  for (const [run, l] of Object.entries(live).filter(([, x]) => !x.job)) {
    const item: Item = { k: "live", live: l, receipts: lastOut.has(run) ? [] : (receipts.get(run) ?? []), run, at: Date.now() };
    if (!after(run, item)) items.push(item);
  }
  // Work done for a job (its coding agent) is part of that job's card, not a card of its own.
  for (const job of [...jobs].filter((j) => !j.part_of).sort((a, b) => a.started_at - b.started_at)) {
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

const keyOf = (it: Item) =>
  it.k === "row"
    ? it.row.id
    : it.k === "receipts"
      ? it.rows[0]!.id
      : it.k === "live"
        ? `live:${it.run}`
        : it.k === "job"
          ? `job:${it.job.id}`
          : it.p.client_id;

function dayLabel(at: number): string {
  const d = startOfDay(new Date(at)).getTime();
  const today = startOfDay(new Date()).getTime();
  const date = new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  if (d === today) return `Today · ${date}`;
  if (d === today - 86_400_000) return `Yesterday · ${date}`;
  return new Date(at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

/** What the diamond is doing: listening, thinking or speaking in a call, thinking while a run is under way, idle otherwise. */
export function diamondState(atlas: Atlas): DiamondState {
  if (atlas.inCall) {
    const v = atlas.voice.status;
    return v === "listening" || v === "thinking" || v === "speaking" ? v : "idle";
  }
  return Object.values(atlas.state.live).some((l) => l.surface !== "voice" && !l.job) || atlas.state.pending.some((p) => !p.run_id)
    ? "thinking"
    : "idle";
}

/** The first thing waiting on the owner, in a few words, for the strip above the composer. */
function needLine(i: InboxItem): string {
  if (i.job) return i.job.question;
  return i.title;
}

/** When each run was first seen working, so its line can count the seconds. */
const liveSince = new Map<string, number>();
/** Runs seen streaming here, and words just sent from here: their saved rows take their place without moving again. */
const seenLive = new Set<string>();
const justSent = new Map<string, number>();

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
  // What was already here when the thread first loaded stays put; what arrives after rises into place, once.
  const known = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());

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
    if (el.firstElementChild) o.observe(el.firstElementChild);
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
  const items = arrange(rows, live, topJobs(s.jobs), pending);
  for (const it of items) {
    if (it.k === "live") {
      seenLive.add(it.run);
      if (!liveSince.has(it.run)) liveSince.set(it.run, Date.now());
    }
    if (it.k === "pending") justSent.set(it.p.text, Date.now());
  }
  if (loaded && known.current == null) known.current = new Set(items.map(keyOf));
  const isFresh = (it: Item): boolean => {
    const key = keyOf(it);
    if (!known.current || known.current.has(key)) return fresh.current.has(key);
    known.current.add(key);
    // A reply saved after it streamed here, or words saved after they were sent from here, are already in place.
    const settled =
      (it.k === "row" && it.row.kind === "message.out" && it.run != null && seenLive.has(it.run)) ||
      (it.k === "row" && it.row.kind === "message.in" && Date.now() - (justSent.get(str(it.row.body.text)) ?? 0) < 60_000);
    if (!settled) fresh.current.add(key);
    return !settled;
  };
  const empty = loaded && items.length === 0;
  const todayAt = startOfDay(new Date()).getTime();
  // Today opens with Atlas's presence, in place of the day's marker; with nothing yet today, it's the newest thing here.
  const heroAt = items.findIndex((it) => it.at >= todayAt);
  const hero = loaded ? <Presence key="presence" atlas={atlas} opens={opens} empty={empty} /> : null;
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
          {[
            ...items.flatMap((it, i) => {
              const label = dayLabel(it.at);
              const sep = label !== day;
              day = label;
              const key = keyOf(it);
              const turn = (it.k === "row" && it.row.kind === "message.in") || it.k === "pending";
              return [
                ...(i === heroAt && hero ? [hero] : []),
                <div key={key} className={`item ${turn ? "turn" : ""} ${isFresh(it) ? (turn ? "lift" : "rise") : ""}`}>
                  {sep && i !== heroAt && (
                    <div className="day">
                      <span className="lab">{label}</span>
                    </div>
                  )}
                  <ItemView atlas={atlas} item={it} undone={undone} opens={opens} />
                </div>,
              ];
            }),
            ...(heroAt < 0 && hero ? [hero] : []),
          ]}
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

/**
 * Atlas's presence, opening the day (§21.8, docs/ui 02): the living diamond,
 * a greeting, and what matters now: what's next, what waits on the owner, and
 * what Atlas is at work on. Each opens where it lives.
 */
function Presence({ atlas, opens, empty }: { atlas: Atlas; opens: Opens; empty: boolean }) {
  const s = atlas.state;
  const now = useNow();
  const today = startOfDay(new Date(now));
  const cal = useCalendar(atlas, "presence", today, addDays(today, 2));
  const events = (cal?.events ?? []).filter((e) => !e.all_day && eventEnd(e).getTime() > now);
  const next = events[0];
  const underway = next && eventStart(next).getTime() <= now;
  const inbox = (s.inbox ?? []).filter((i) => !s.answered[i.id]);
  const jobs = topJobs(s.jobs);
  const working = jobs.filter((j) => jobNow(j, now).live);
  const owner = s.view?.settings.owner_name?.split(" ")[0];
  const narrow = window.matchMedia("(max-width: 760px)").matches;
  const nextDay = next && startOfDay(eventStart(next)).getTime() !== today.getTime() ? " tomorrow" : "";
  const line = [
    next
      ? underway
        ? `${next.title} until ${clock(eventEnd(next))}.`
        : `${next.title} at ${clock(eventStart(next))}${nextDay}.`
      : s.view?.calendar.provider
        ? "Nothing else on the calendar today."
        : "",
    inbox.length === 0 ? "Nothing needs you." : inbox.length === 1 ? "One thing needs you." : `${inbox.length} things need you.`,
  ]
    .filter(Boolean)
    .join(" ");
  const minutes = next ? Math.round((eventStart(next).getTime() - now) / 60_000) : 0;
  const away = !next
    ? ""
    : underway
      ? "Now"
      : minutes < 60
        ? `In ${Math.max(1, minutes)} min`
        : minutes < 24 * 60
          ? `In ${Math.round(minutes / 60)} h`
          : "Tomorrow";
  const first = working[0] ?? jobs.find((j) => j.state === "running");
  return (
    <section className={`presence ${empty ? "alone" : ""}`} aria-label="Now">
      <div className="pr-mark">
        <AsciiDiamond height={narrow ? 96 : 152} level={atlas.inCall ? atlas.voice.level : 0} state={diamondState(atlas)} />
      </div>
      <div className="pr-body">
        <span className="lab pr-day">{dayLabel(now)}</span>
        <h1 className="disp pr-hello">
          {greeting(new Date(now))}
          {owner ? `, ${owner}` : ""}.
        </h1>
        <p className="pr-line">{line}</p>
        <div className="pr-cells">
          <button className="pr-cell" onClick={opens.week}>
            <span className="lab">Next</span>
            {next ? (
              <>
                <span className="pr-v clip">{next.title}</span>
                <span className="pr-a mono">
                  {away} · {clock(eventStart(next))}
                </span>
              </>
            ) : (
              <>
                <span className="pr-v faint">{s.view?.calendar.provider ? "Clear" : "No calendar yet"}</span>
                <span className="pr-a mono">{s.view?.calendar.provider ? "The rest of today" : "Add one in Abilities"}</span>
              </>
            )}
          </button>
          <button className={`pr-cell ${inbox.length ? "needs" : ""}`} onClick={opens.inbox}>
            <span className="lab">
              Needs you{" "}
              {inbox.length > 0 && (
                <span className="pr-n">
                  · <CountUp value={inbox.length} />
                </span>
              )}
            </span>
            <span className="pr-v clip">{inbox[0] ? inbox[0].title : "Nothing waiting"}</span>
            <span className="pr-a mono">
              {inbox.length > 1 ? `And ${inbox.length - 1} more` : inbox.length ? "Open Inbox" : "Empty is the goal"}
            </span>
          </button>
          <button
            className="pr-cell"
            onClick={(e) => {
              if (!first) return;
              morphOrigin(e.currentTarget);
              opens.job(first);
            }}
            disabled={!first}
          >
            <span className="lab">
              At work{" "}
              {working.length > 0 && (
                <span>
                  · <CountUp value={working.length} />
                </span>
              )}
            </span>
            <span className="pr-v clip">
              {working.length > 0 && <span className="mono spin" aria-hidden />}
              {first ? first.title : "Nothing running"}
            </span>
            <span className="pr-a mono clip">{first ? (first.owned?.now ?? jobNow(first, now).label) : "Ask for something big"}</span>
          </button>
        </div>
        {empty && <p className="pr-hint">Ask me anything, tell me something to remember, or press Space to talk.</p>}
      </div>
    </section>
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
      <span className="ns-label lab">Needs you</span>
      <span className="clip grow">{needLine(first)}</span>
      {all.length > 1 && <span className="ns-more mono">+{all.length - 1}</span>}
      <Icon name="right" size={13} />
    </button>
  );
}

/** Atlas's mark beside its words: alive only on the message being written. */
function Glyph({ state }: { state?: DiamondState }) {
  return (
    <span className="mark">
      <LiveMark size={15} state={state ?? "still"} />
    </span>
  );
}

/** What Atlas is doing on a reply, before and between its words: a tool's status in mono, with the seconds it has taken. */
function Working({ run, status }: { run: string; status: string | null }) {
  const now = useNow(1000);
  const since = liveSince.get(run) ?? now;
  return (
    <p className="working" aria-live="polite">
      <span className="mono spin" aria-hidden />
      <span className="w-text" key={status ?? "thinking"}>
        {status ?? "Thinking"}
      </span>
      <span className="w-time mono">{elapsed(now - since)}</span>
    </p>
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
        <div className="msg atlas live">
          <Glyph state={atlas.inCall && item.live.surface === "voice" ? (atlas.voice.status as DiamondState) : "thinking"} />
          <div className="body">
            {(item.live.status || !item.live.text) && <Working run={item.run} status={item.live.status} />}
            {item.live.text && <Markdown className="said streaming" text={item.live.text} />}
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
          <span className="when keep">
            <span className="mono">{item.p.run_id ? "Sent" : "Sending"}</span>
          </span>
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
          {chips.map((r, i) => (
            <span
              key={r.id}
              data-row={r.id}
              data-approval={(r.body.receipt as { approval?: string } | undefined)?.approval}
              style={{ "--i": i } as React.CSSProperties}
            >
              <Receipt
                row={r}
                atlas={atlas}
                undone={undone.has(r.id)}
                onOpen={(e) => {
                  morphOrigin(e?.currentTarget.closest(".receipt"));
                  opens.receipt(r);
                }}
              />
            </span>
          ))}
        </div>
      )}
      {waiting.map(([r, item]) => (
        <div key={`ok:${r.id}`} className="approval-inline rise" data-approval={item.id}>
          <span className="q-for lab ac">
            <span className="sq-ac" aria-hidden />
            Needs your OK · {item.title}
          </span>
          <ApprovalCard atlas={atlas} a={item.approval!} />
        </div>
      ))}
      {cards.map(([r, v]) => (
        <div key={r.id} data-row={r.id}>
          <StageCard atlas={atlas} shown={v} row={r} onOpen={() => opens.view(v)} />
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
            <span className="mono">{clock(row.at)}</span>
          </span>
        </div>
      );
    }
    case "message.out":
      return (
        <div className="msg atlas" data-row={row.id}>
          <Glyph />
          <div className="body">
            <Markdown className="said" text={str(b.text)} />
            {receipts.length > 0 && <Receipts atlas={atlas} rows={receipts} undone={undone} opens={opens} />}
            <span className={`when ${row.surface === "voice" || b.interrupted ? "keep" : ""}`}>
              {voiceTag}
              {b.interrupted ? <span>Interrupted</span> : null}
              {at("developer") && <Timing timing={b.timing} />}
              <span className="mono">{clock(row.at)}</span>
            </span>
          </div>
        </div>
      );
    case "job.question":
      return (
        <div className="msg atlas asks" data-row={row.id}>
          <Glyph />
          <div className="body">
            <QuestionBody atlas={atlas} q={questionFromRow(row)} open={isOpen(atlas, row.id)} />
            <span className="when">
              <span className="mono">{clock(row.at)}</span>
            </span>
          </div>
        </div>
      );
    case "job.result":
      return (
        <div className="msg atlas" data-row={row.id}>
          <Glyph />
          <div className="body">
            <ResultBody row={row} />
            <span className="when">
              <span className="mono">{clock(row.at)}</span>
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
