// The conversation (§21.1): Home is the whole thread, text and voice alike.
// Each day opens with Atlas's presence: the living diamond, a greeting, and
// what matters now. Then Atlas's words with the receipts for what it did under
// them, the owner's words, approvals waiting for an OK, each job as a live card
// under the message that asked for it, and a job's questions and result as
// messages with their buttons and files. The composer sits at the bottom, with
// what needs the owner just above it. Messages carry their area chip; tapping
// it moves the message (§6.3).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InboxItem, JobView, LogRow } from "../../core/src/protocol";
import { ApprovalCard } from "./Approval";
import { FrontPage } from "./FrontPage";
import type { Atlas, Live, Pending } from "./connection";
import { isOpen, JobCard, questionFromRow, QuestionBody, ResultBody, topJobs } from "./JobViews";
import { jobNow } from "./jobs";
import { InlineText, Markdown } from "./Markdown";
import { eventEnd, eventStart, useCalendar } from "./pages/Week";
import { Composer, Receipt, VoiceStrip } from "./Shell";
import { type Shown, shownFrom, StageCard } from "./StageViews";
import { stillMotion, useDetail } from "./theme";
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

/** How much of the plumbing the thread shows: brain fallbacks only at Developer, Atlas's silent runs from Detailed (§21.5). */
interface Shows {
  dev: boolean;
  detailed: boolean;
}

/** Whether a row is a message in the conversation. A job's updates aren't: they're on its card and in its own thread. */
function shows(r: LogRow, at: Shows): boolean {
  // A job's own rows (the owner's words and answers to it, what its turns did) are its thread's, not the main one (§21.4).
  if ((r.kind === "message.in" || r.kind === "tool.result") && r.body.job != null) return false;
  switch (r.kind) {
    case "brain.fallback":
      return at.dev;
    case "message.in":
    case "message.out":
    case "voice.problem":
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
function arrange(rows: LogRow[], live: Record<string, Live>, jobs: JobView[], pending: Pending[], at: Shows): Item[] {
  const visible = rows.filter((r) => shows(r, at));
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
      // What one of Atlas's own runs did without saying anything (a skill review, a silent automation) is History's,
      // not the conversation's: what matters from those, Atlas brings into the thread in its own words (§21.2).
      if (r.surface === "none" && !at.detailed) continue;
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
  const { at } = useDetail();
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
  const items = arrange(rows, live, topJobs(s.jobs), pending, { dev: at("developer"), detailed: at("detailed") });
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
  // Until the owner says something today, the day opens on the front page; then its presence in the thread.
  const spokeToday = items.some((it) => it.at >= todayAt && (it.k === "pending" || (it.k === "row" && it.row.kind === "message.in")));
  const hero = !loaded ? null : spokeToday ? (
    <Presence key="presence" atlas={atlas} opens={opens} empty={empty} />
  ) : (
    <FrontPage key="front" atlas={atlas} opens={opens} />
  );
  let day = "";

  return (
    <div className="sheet convo">
      <GridRipple active={diamondState(atlas) === "thinking"} />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <div className="thread" ref={box} onScroll={onScroll}>
        <div className="thread-col">
          {!loaded && (
            // Loading is the page's shape with the mark at rest, never a sentence (M7 W16).
            <div className="thread-loading" aria-busy="true" aria-label={`Connecting to ${name}`}>
              <AsciiDiamond height={84} state="idle" />
              <span className="sk" style={{ width: "62%" }} />
              <span className="sk" style={{ width: "78%" }} />
              <span className="sk own" style={{ width: "34%" }} />
            </div>
          )}
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
        {/* The front page shows what needs the owner in its own tile, so the strip waits until they've spoken. */}
        {(spokeToday || !loaded) && <NeedsYou atlas={atlas} onOpen={opens.inbox} />}
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

/** The diamond's ramp, lightest to densest, for the grid while Atlas works. */
const RAMP = ".:-=+*#%@";

/**
 * The grid while Atlas works (VISION §21.8, M7 W17): the stage's dots near Atlas's mark on the reply it's writing
 * turn into the diamond's characters in ember and ripple outward; when it's done they settle back into dots. A
 * canvas over the stage's own dots, lined up with them, at most 30 frames a second, only near the mark, and nothing
 * with reduced motion.
 */
function GridRipple({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const state = useRef({ active, since: 0, ended: 0 });
  useEffect(() => {
    const st = state.current;
    if (active && !st.active) st.since = performance.now();
    if (!active && st.active) st.ended = performance.now();
    st.active = active;
  }, [active]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || stillMotion()) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const ember = getComputedStyle(document.documentElement).getPropertyValue("--ac").trim() || "#ff6a3d";
    let raf = 0;
    let last = 0;
    let drawn = false;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return;
      last = t;
      const st = state.current;
      const settling = !st.active && t - st.ended < 900;
      if (!st.active && !settling) {
        if (drawn) {
          ctx.clearRect(0, 0, cv.width, cv.height);
          drawn = false;
        }
        return;
      }
      const box = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(box.width * dpr) || cv.height !== Math.round(box.height * dpr)) {
        cv.width = Math.round(box.width * dpr);
        cv.height = Math.round(box.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);
      drawn = true;
      const mark = cv.parentElement?.querySelector(".msg.live .mark")?.getBoundingClientRect();
      // The reply being written stays clear: the ripple goes around its words, never under them.
      const words = cv.parentElement?.querySelector(".msg.live .body")?.getBoundingClientRect();
      const stage = cv.closest(".stage")?.getBoundingClientRect();
      if (!mark || !stage) return;
      const ox = mark.left + mark.width / 2 - box.left;
      const oy = mark.top + mark.height / 2 - box.top;
      // The stage's dots sit at the middle of each 16 px tile from its corner.
      const x0 = ((((stage.left - box.left + 8) % 16) + 16) % 16) - 16;
      const y0 = ((((stage.top - box.top + 8) % 16) + 16) % 16) - 16;
      const sec = (t - st.since) / 1000;
      const fade = settling ? 1 - (t - st.ended) / 900 : Math.min(1, sec / 0.4);
      ctx.font = '500 10px "Geist Mono", ui-monospace, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = ember;
      const R = 440;
      for (let y = Math.max(y0, oy - R); y < Math.min(box.height, oy + R); y += 16) {
        const gy = y0 + Math.round((y - y0) / 16) * 16;
        for (let x = Math.max(x0, ox - R); x < Math.min(box.width, ox + R); x += 16) {
          const gx = x0 + Math.round((x - x0) / 16) * 16;
          const d = Math.hypot(gx - ox, (gy - oy) * 1.15);
          if (d > R) continue;
          if (
            words &&
            gx + box.left > words.left - 6 &&
            gx + box.left < words.right + 6 &&
            gy + box.top > words.top - 6 &&
            gy + box.top < words.bottom + 6
          )
            continue;
          let lit = 0;
          for (let k = 0; k < 3; k++) {
            const r = (sec * 170 + k * 140) % 420;
            lit = Math.max(lit, Math.exp(-Math.pow((d - r) / 22, 2)) * (1 - r / 420));
          }
          lit = lit * (1 - d / R) + 0.08 * Math.exp(-d / 40);
          lit *= fade;
          if (lit < 0.07) continue;
          const ch = RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(lit * (RAMP.length - 1))))]!;
          ctx.globalAlpha = Math.min(0.55, lit * 0.8);
          ctx.fillText(ch, gx, gy);
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="grid-ripple" aria-hidden />;
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

/** A finished step of a reply, in a word or two, for its node: "search", "reuters.com", "reminder". */
function nodeLabel(r: LogRow): string {
  const rc = r.body.receipt as { text?: string; link?: string } | undefined;
  if (rc?.link) return hostOf(rc.link) || "page";
  if (r.body.name === "web_search") return "search";
  return (rc?.text ?? String(r.body.name ?? "")).split(" · ")[0]!.toLowerCase().slice(0, 24);
}

/**
 * What Atlas is doing on a reply, before and between its words (M7 W17): one line whose verb changes in place, with
 * the seconds it has taken, and a node for each step it has finished on a short rail, the one under way in ember.
 */
function Working({ run, status, done = [] }: { run: string; status: string | null; done?: LogRow[] }) {
  const now = useNow(1000);
  const since = liveSince.get(run) ?? now;
  const steps = done.slice(-4);
  return (
    <div className="working-wrap">
      <p className="working" aria-live="polite">
        <span className="mono spin" aria-hidden />
        <span className="w-text" key={status ?? "thinking"}>
          {status ?? "Thinking"}
        </span>
        <span className="w-time mono">{elapsed(now - since)}</span>
      </p>
      {steps.length > 0 && (
        <span className="w-nodes" aria-hidden>
          {done.length > steps.length && <span className="w-more mono">+{done.length - steps.length}</span>}
          {steps.map((r) => (
            <span key={r.id} className="w-node done">
              <i />
              {nodeLabel(r)}
              <span className="w-link" />
            </span>
          ))}
          <span className="w-node live">
            <i />
          </span>
        </span>
      )}
    </div>
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
            {(item.live.status || !item.live.text) && <Working run={item.run} status={item.live.status} done={item.receipts} />}
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

/** A receipt for a lookup that changed nothing: a search or a page read (receipts saved before `look` was kept are known by their tool). */
export function isLook(r: LogRow): boolean {
  const rc = r.body.receipt as { look?: boolean; view?: unknown; undo?: unknown; approval?: unknown } | undefined;
  if (!rc) return false;
  if (rc.look === true) return true;
  return rc.view == null && rc.undo == null && rc.approval == null && (r.body.name === "web_search" || r.body.name === "web_fetch");
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * What Atlas looked at for a reply (§21.5 at Simple, M7 W17): each site it read as a source with its mark, which
 * opens the page, and a search as one quiet pill. "Details" opens each search and page as its receipt.
 */
function Lookups({ atlas, rows, undone }: { atlas: Atlas; rows: LogRow[]; undone: Set<string> }) {
  const [open, setOpen] = useState(false);
  const pages = new Map<string, string>();
  for (const r of rows) {
    const link = (r.body.receipt as { link?: string }).link;
    const host = link ? hostOf(link) : "";
    if (host && !pages.has(host)) pages.set(host, link!);
  }
  const searches = rows.filter((r) => r.body.name === "web_search").length;
  if (open)
    return (
      <>
        {rows.map((r, i) => (
          <span key={r.id} data-row={r.id} style={{ "--i": i } as React.CSSProperties}>
            <Receipt row={r} atlas={atlas} undone={undone.has(r.id)} />
          </span>
        ))}
        <button className="src more" onClick={() => setOpen(false)}>
          Fewer
        </button>
      </>
    );
  return (
    <span className="sources" data-row={rows[0]!.id}>
      {[...pages].slice(0, 4).map(([host, link], i) => (
        <a key={host} className="src" href={link} target="_blank" rel="noreferrer" title={link} style={{ "--i": i } as React.CSSProperties}>
          <span className="src-mark" aria-hidden>
            {host.replace(/^(m|en|news)\./, "")[0]!.toUpperCase()}
          </span>
          {host}
        </a>
      ))}
      {pages.size === 0 && searches > 0 && (
        <span className="src">
          <span className="src-mark" aria-hidden>
            <Icon name="search" size={10} />
          </span>
          {searches === 1 ? "Searched the web" : `Searched the web ${searches} times`}
        </span>
      )}
      <button className="src more" onClick={() => setOpen(true)} title="Each search and page">
        {pages.size > 4 ? `+${pages.size - 4} · Details` : "Details"}
      </button>
    </span>
  );
}

/** The receipts for what Atlas did, under its message: views it showed as cards, approvals waiting as their card, the rest as chips. */
function Receipts({ atlas, rows, undone, opens }: { atlas: Atlas; rows: LogRow[]; undone: Set<string>; opens: Opens }) {
  const inbox = atlas.state.inbox ?? [];
  const { at } = useDetail();
  const shown = rows.map((r) => [r, shownFrom(r)] as const);
  const all = shown.filter(([, v]) => !v).map(([r]) => r);
  // At Simple, lookups (searches, pages read) fold into one line; what changed something keeps its own receipt.
  const looks = at("detailed") ? [] : all.filter(isLook);
  const chips = all.filter((r) => !looks.includes(r));
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
      {(chips.length > 0 || looks.length > 0) && (
        <div className="receipts">
          {looks.length > 0 && <Lookups atlas={atlas} rows={looks} undone={undone} />}
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
  // At Simple a message carries only its time, on hover: the area chip only when it has an area, the voice tag from Detailed.
  const voiceTag =
    row.surface === "voice" && at("detailed") ? (
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
          <span className={`when ${row.areas.length || voiceTag ? "keep" : ""}`}>
            {voiceTag}
            {s.areas.length > 0 && (row.areas.length > 0 || at("detailed")) && chip}
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
            <span className={`when ${voiceTag || b.interrupted ? "keep" : ""}`}>
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
