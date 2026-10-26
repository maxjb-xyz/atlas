// Home (§21.1, §21.2): the conversation, and the stage it opens. The whole
// thread fills Home with the composer at its foot; when Atlas shows something,
// or a receipt, a job or Now and the week are opened, the stage opens large
// beside the thread (over it on a narrow screen) and closes back to it.

import { InlineText } from "../Markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JobView, LogRow } from "../../../core/src/protocol";
import { jobNow, liveJobs } from "../jobs";
import type { StageView } from "../../../core/src/stage";
import type { Atlas } from "../connection";
import { type Shown, shownFrom, StageSheet, titleOf } from "../StageViews";
import { Conversation, diamondState, isLook, type Opens } from "../Thread";
import { JobDetail, JobGone } from "../JobViews";
import { MapCanvas, whereLine } from "../SenseViews";
import { sky, temp } from "../../../core/src/weather";
import { useDetail } from "../theme";
import { ApprovalCard } from "../Approval";
import {
  addDays,
  areaColor,
  AreaDot,
  AreaTag,
  AsciiDiamond,
  clock,
  dayName,
  Icon,
  Sheet,
  shortDay,
  Stage,
  startOfDay,
  StateDot,
  useMorphIn,
  useNow,
} from "../ui";
import { CalendarNote, eventArea, eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

/** What the stage shows: Now, the week, a view Atlas showed, a job's thread, a receipt, or an approval. */
type Tab = "now" | "week" | "receipt" | "approval" | `view:${string}` | `job:${string}`;

/** The approval a receipt waits on, if it does. */
const approvalOf = (r: LogRow) => (r.body.receipt as { approval?: string } | undefined)?.approval ?? null;

/** The most views and jobs the stage keeps open at once; the oldest closes first. */
const MAX_OPEN = 4;

/** What a view shows, for views that are one thing however often they're shown; null for one-off views (a list, a chart). */
function identity(s: Shown): string | null {
  const v = s.view;
  switch (v.kind) {
    case "workspace":
    case "browser":
      return v.kind;
    case "file":
      return `file:${v.file}`;
    case "area":
      return `area:${v.area}`;
    case "person":
      return `person:${v.person}`;
    case "automation":
      return `automation:${v.automation}`;
    case "page":
      return `page:${v.page}`;
    case "mcp_app":
      return `mcp_app:${v.call}`;
    case "place":
      return `place:${v.place}`;
    case "day":
      return `day:${v.date}`;
    case "weather":
    case "situation":
    case "senses":
      return v.kind;
    default:
      return null;
  }
}
const sameThing = (a: Shown, b: Shown) => {
  const k = identity(a);
  return k != null && k === identity(b);
};

/**
 * What's open on Home's stage, kept while the app is open (and through a
 * reload, in this tab), so leaving Home and coming back finds it as it was.
 * `tab` is null while the stage is closed. `seen` is the last log row the
 * stage has looked at for new views.
 */
interface Kept {
  tab: Tab | null;
  views: Shown[];
  jobs: string[];
  approval: string | null;
  seen: number | null;
}
const KEPT_KEY = "atlas.home";
let kept: Kept = (() => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEPT_KEY) ?? "null") as Kept | null;
    if (v && Array.isArray(v.views) && Array.isArray(v.jobs)) return v;
  } catch {
    // No storage here (a private window): the stage starts closed.
  }
  return { tab: null, views: [], jobs: [], approval: null, seen: null };
})();
function keep(next: Kept): void {
  kept = next;
  try {
    sessionStorage.setItem(KEPT_KEY, JSON.stringify(next));
  } catch {
    // Too big or not allowed: it's still kept for this visit.
  }
}

export function Home({ atlas, detail, go, place }: { atlas: Atlas; detail: string; go: (d: string) => void; place: (p: "inbox") => void }) {
  const s = atlas.state;
  // The stage outlives a visit to another page: what was open comes back with Home.
  const [tab, setTab] = useState<Tab | null>(() => kept.tab);
  const [receipt, setReceipt] = useState<LogRow | null>(null);
  const [views, setViews] = useState<Shown[]>(() => kept.views);
  const [jobs, setJobs] = useState<string[]>(() => kept.jobs);
  const [approval, setApproval] = useState<string | null>(() => kept.approval);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    keep({ tab: tab === "receipt" ? null : tab, views, jobs, approval, seen: kept.seen });
  }, [tab, views, jobs, approval]);

  // Showing the same thing again (the workspace, a file, an area) reuses its place, instead of adding one.
  const openView = (v: Shown) => {
    const matches = (x: Shown) => x.id === v.id || sameThing(x, v);
    const at = views.find(matches)?.id ?? v.id;
    setViews((list) => {
      const same = list.find(matches);
      return same ? list.map((x) => (x === same ? { ...v, id: same.id } : x)) : [...list, v].slice(-MAX_OPEN);
    });
    setTab(`view:${at}`);
  };
  const openJob = (id: string) => {
    setJobs((list) => [...list.filter((x) => x !== id), id].slice(-MAX_OPEN));
    setTab(`job:${id}`);
  };
  const openReceipt = (r: LogRow) => {
    const shown = shownFrom(r);
    if (shown) return openView(shown);
    const asking = approvalOf(r);
    if (asking && s.inbox?.some((i) => i.id === asking)) {
      setApproval(asking);
      return setTab("approval");
    }
    setReceipt(r);
    setTab("receipt");
  };
  const toggle = (t: Tab) => setTab((cur) => (cur === t ? null : t));
  const close = () => setTab(null);

  // From elsewhere: a job ("job:<id>", or "jobs:<id>" from older links), a view ("view:<receipt id>"), or where something was asked ("at:<row id>").
  useEffect(() => {
    if (!detail) return;
    if (detail.startsWith("job:") || detail.startsWith("jobs:")) openJob(detail.slice(detail.indexOf(":") + 1));
    else if (detail.startsWith("view:")) {
      const id = detail.slice(5);
      const row = s.rows.find((r) => r.id === id) ?? s.history?.rows.find((r) => r.id === id);
      const shown = row && shownFrom(row);
      if (shown) openView(shown);
    } else if (detail.startsWith("at:")) {
      // Shown where it was asked: on a narrow screen the stage gives way to the thread.
      setFocus(detail.slice(3));
      if (window.matchMedia("(max-width: 1180px)").matches) close();
    }
    go("");
  }, [detail]);

  // A view Atlas shows opens the stage (§21.6), including one shown while another page was open.
  // Views already in the thread when the app opened stay behind their cards.
  useEffect(() => {
    if (!s.loaded) return;
    const last = s.rows.at(-1)?.seq ?? 0;
    if (kept.seen == null) {
      keep({ ...kept, seen: last });
      return;
    }
    const fresh = s.rows.filter((r) => r.seq > kept.seen! && r.kind === "tool.result");
    keep({ ...kept, seen: Math.max(kept.seen, last) });
    const newest = fresh
      .map(shownFrom)
      .filter((v): v is Shown => v != null)
      .at(-1);
    if (newest) openView(newest);
  }, [s.rows, s.loaded]);

  const now = useNow();
  const tz = s.view?.settings.timezone;
  const job = tab?.startsWith("job:") ? s.jobs.find((j) => j.id === tab.slice(4)) : undefined;
  const opens: Opens = {
    view: openView,
    job: (j: JobView) => openJob(j.id),
    receipt: openReceipt,
    now: () => toggle("now"),
    week: () => toggle("week"),
    inbox: () => place("inbox"),
  };
  // While the stage is open, what else is open on it shows beside Now and Week, so it's one tap back.
  const pills: Array<{ id: Tab; label: string }> = [
    { id: "now", label: "Now" },
    { id: "week", label: "Week" },
    ...(tab
      ? [
          ...views.map((v) => ({ id: `view:${v.id}` as Tab, label: titleOf(atlas, v) })),
          ...jobs
            .map((id) => s.jobs.find((j) => j.id === id))
            .filter((j): j is JobView => j != null)
            .map((j) => ({ id: `job:${j.id}` as Tab, label: j.title })),
          ...(approval && s.inbox?.some((i) => i.id === approval) ? [{ id: "approval" as Tab, label: "Your OK" }] : []),
          ...(receipt ? [{ id: "receipt" as Tab, label: "Receipt" }] : []),
        ]
      : []),
  ];

  return (
    <Stage
      label="Home"
      home
      bodyClass="home-body"
      meta={tab ? null : `${dayName(now)} · ${clock(now)}${tz ? ` · ${tz}` : ""}`}
      actions={
        <div className="stage-opens">
          <div className="tabs" role="tablist" aria-label="Open on the stage">
            {pills.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === tab}
                className={p.id === tab ? "on" : ""}
                onClick={() => toggle(p.id)}
                title={p.label}
              >
                {p.id.startsWith("job:") && jobNow(s.jobs.find((j) => `job:${j.id}` === p.id)!).live && (
                  <span className="mono spin" aria-hidden />
                )}
                <span className="tab-label">{p.label}</span>
              </button>
            ))}
          </div>
          {tab && (
            <button className="icon" aria-label="Close the stage" title="Back to the conversation" onClick={close}>
              <Icon name="x" />
            </button>
          )}
        </div>
      }
    >
      <div className={`home-split ${tab ? "open" : ""}`}>
        <Conversation atlas={atlas} opens={opens} focus={focus} onFocused={() => setFocus(null)} />
        {tab && (
          <StageArea key={tab} at={tab}>
            <button className="btn sm home-back" onClick={close}>
              <Icon name="left" size={13} /> Conversation
            </button>
            {tab === "now" && (
              <Now
                atlas={atlas}
                showSituation={() => openView({ id: "local:situation", view: { kind: "situation" }, title: "Situation" })}
              />
            )}
            {tab === "week" && <WeekTab atlas={atlas} />}
            {tab.startsWith("job:") && (job ? <JobDetail atlas={atlas} job={job} /> : <JobGone />)}
            {tab === "receipt" && receipt && <ReceiptView atlas={atlas} row={receipt} />}
            {tab === "approval" && approval && <ApprovalTab atlas={atlas} id={approval} />}
            {views
              .filter((v) => tab === `view:${v.id}`)
              .map((v) => (
                <StageSheet
                  key={v.id}
                  atlas={atlas}
                  shown={v}
                  onOpen={(view: StageView, title: string) => openView({ id: `local:${JSON.stringify(view)}`, view, title })}
                />
              ))}
          </StageArea>
        )}
      </div>
    </Stage>
  );
}

/** Where the stage opens beside the thread; it grows out of the card, receipt or line that opened it (§21.8). */
function StageArea({ at, children }: { at: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useMorphIn(ref, at);
  return (
    <div className="home-stage" ref={ref}>
      {children}
    </div>
  );
}

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

/**
 * Now (§21.6, docs/ui §8): the living diamond and a line about your day,
 * with receipts for what Atlas just did; what's next on a small map with
 * when to leave; the weather; what needs you and the jobs running; and the
 * week, stacked in area colors.
 */
function Now({ atlas, showSituation }: { atlas: Atlas; showSituation: () => void }) {
  const s = atlas.state;
  const { at } = useDetail();
  // The situation (§10.2): where you are, leave-by and weather that matters, rebuilt by the agent from what the senses said.
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.stage", ref: "situation", view: { kind: "situation" } });
    atlas.send({ type: "atlas.stage", ref: "weather", view: { kind: "weather" } });
  }, [atlas.voice.connected, s.situationVersion]);
  const sit = s.stage.situation?.kind === "situation" ? s.stage.situation : null;
  const wx = s.stage.weather?.kind === "weather" ? s.stage.weather : null;
  const nowMs = useNow();
  const today = startOfDay(new Date());
  // From Monday, so the week's load counts the days already gone, through a week from today for Next.
  const monday = weekStart(today);
  const cal = useCalendar(atlas, "now", monday, addDays(today, 8));
  const events = (cal?.events ?? []).filter((e) => eventEnd(e).getTime() > Date.now());
  const next = events.find((e) => !e.all_day) ?? events[0];
  const reminder = s.agenda.find((a) => (a.kind === "reminder" || a.kind === "promise") && a.state === "scheduled");
  const owner = s.view?.settings.owner_name?.split(" ")[0];
  const inbox = s.inbox ?? [];
  const running = liveJobs(s.jobs);
  const stuck = s.jobs.filter((j) => jobNow(j).label === "Stalled");
  const scoped = s.areas.find((a) => a.id === s.scope);
  // Each day's events, so its bar stacks in the colors of their areas.
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    const e = addDays(d, 1);
    return (cal?.events ?? []).filter((x) => eventStart(x) < e && eventEnd(x) > d);
  });
  const load = days.map((d) => d.length);
  const busiest = load.indexOf(Math.max(...load));
  const max = Math.max(1, ...load);
  const underway = next && !next.all_day && eventStart(next).getTime() <= Date.now();
  const leave = sit?.next?.travel && sit.next.travel.leave_by > nowMs - 15 * 60_000 ? sit.next : null;
  const line = leave
    ? `Leave by ${clock(leave.travel!.leave_by)} for ${leave.title}.`
    : underway
      ? `Now: ${next.title}, until ${clock(eventEnd(next))}.`
      : next
        ? `Nothing on the calendar until ${dayName(eventStart(next))}${next.all_day ? "" : ` at ${clock(eventStart(next))}`}.`
        : s.view?.calendar.provider
          ? "Nothing on the calendar this week."
          : "Connect a calendar in Abilities and I'll keep an eye on your week.";
  const where = sit && sit.where.known ? whereLine(sit, nowMs) : null;
  const needs = inbox.length ? `${inbox.length === 1 ? "One thing needs" : `${inbox.length} things need`} you.` : "";
  // What Atlas did today, as receipts under the greeting.
  const done = s.rows
    .filter(
      (r) =>
        r.kind === "tool.result" &&
        r.body.receipt &&
        r.body.ok !== false &&
        r.at >= today.getTime() &&
        // Lookups changed nothing, and Atlas's own silent runs (a skill review) are History's.
        !isLook(r) &&
        r.surface !== "none",
    )
    .slice(-2)
    .reverse();
  const u = wx?.units ?? sit?.units ?? "metric";
  const hours = (wx?.weather?.hours ?? []).filter((h) => h.t > Date.now() - 3_600_000).slice(0, 24);
  const tMax = Math.max(...hours.map((h) => h.temp_c), 1);
  const tMin = Math.min(...hours.map((h) => h.temp_c), 0);
  const travel = sit?.next?.travel && next && sit.next.title === next.title ? sit.next.travel : null;
  const nextArea = next ? eventArea(next, s.areas) : undefined;
  // What comes after the next thing, so the card shows the next few days and not one line.
  const after = next ? events.filter((e) => e.id !== next.id && eventStart(e) >= eventStart(next)).slice(0, 3) : [];
  const point = sit?.where.known ? sit.where.point : null;
  // Now opens beside the conversation, so the diamond is smaller than on a page of its own; smaller still on a phone.
  const narrow = useMemo(() => window.matchMedia("(max-width: 760px)").matches, []);

  return (
    <Sheet>
      <div className="sheet-in now">
        <div className="now-head">
          <AsciiDiamond height={narrow ? 120 : 180} level={atlas.inCall ? atlas.voice.level : 0} state={diamondState(atlas)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <h1 className="disp now-hello">
              {scoped ? `${scoped.name}, this week.` : `${greeting(new Date())}${owner ? `, ${owner}` : ""}.`}
            </h1>
            <p className="now-line muted">
              {where ? (
                <a
                  className="link"
                  href="#/home"
                  onClick={(e) => {
                    e.preventDefault();
                    showSituation();
                  }}
                >
                  {where}
                </a>
              ) : null}{" "}
              {line} {needs}
            </p>
            {done.length > 0 && (
              <div className="row" style={{ gap: 8 }}>
                {done.map((r) => (
                  <span key={r.id} className="done-chip">
                    <Icon name="check" size={12} style={{ color: "var(--ok)" }} />
                    {(r.body.receipt as { text: string }).text}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="now-cards">
          <div className="card2 pad now-card">
            <div className="card-head">
              <span className="h2">Next</span>
              {scoped && <AreaTag area={scoped} />}
              <span className="grow" />
            </div>
            {next ? (
              <>
                <span className="disp next-title">{next.title}</span>
                <span className="row aside" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span>{until(eventStart(next), next.all_day, nowMs)}</span>
                  {nextArea && !scoped && <AreaTag area={nextArea} />}
                </span>
                {next.location && (
                  <span className="row small" style={{ gap: 6, color: "var(--tx2)", minWidth: 0 }}>
                    <Icon name="place" size={13} />
                    <span className="clip" title={next.location}>
                      {next.location.split("\n")[0]}
                    </span>
                  </span>
                )}
                {after.length > 0 && (
                  <div className="next-after">
                    <span className="lab">After that</span>
                    {after.map((e) => (
                      <span key={e.id} className="row small" style={{ gap: 8, minWidth: 0 }}>
                        <AreaDot area={eventArea(e, s.areas)} />
                        <span className="clip grow">{e.title}</span>
                        <span className="aside" style={{ flex: "none" }}>
                          {e.all_day ? dayName(eventStart(e)) : `${shortDay(eventStart(e))} · ${clock(eventStart(e))}`}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : reminder ? (
              <>
                <span style={{ fontWeight: 500, fontSize: 15 }}>{reminder.title}</span>
                <span className="aside">
                  {reminder.kind === "promise" ? "Atlas promised" : "Reminder"}, {shortDay(reminder.due_at)}
                </span>
              </>
            ) : (
              <span className="muted">{cal?.error ?? "Nothing coming up."}</span>
            )}
            {/* TODO(core): the route to what's next (its line and where it ends) on SituationPage.next.travel, to draw it here; until then, where you are. */}
            {point && <MapCanvas markers={[{ name: "You", lat: point.lat, lon: point.lon, here: true }]} height={128} />}
            {travel ? (
              <span className="row small" style={{ marginTop: "auto" }}>
                <StateDot state="on" />
                <span className="grow">Leave by {clock(travel.leave_by)}</span>
                <span className="aside">
                  {Math.max(1, Math.round(travel.s / 60))} min by car{travel.traffic ? " · with traffic" : ""}
                </span>
              </span>
            ) : sit?.next?.travel_error ? (
              <span className="aside">{sit.next.travel_error}</span>
            ) : null}
          </div>
          <div className="card2 pad now-card">
            <div className="card-head">
              <span className="h2">Weather</span>
              <span className="grow" />
              {sit?.where.known && sit.where.place && <span className="aside">{sit.where.place.name}</span>}
            </div>
            {wx?.weather ? (
              <>
                <span className="row" style={{ gap: 10, alignItems: "center" }}>
                  <Icon name="sun" size={30} style={{ color: "var(--a1)" }} />
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span className="disp" style={{ fontSize: 26 }}>
                      {temp(wx.weather.now.temp_c, u)}
                    </span>
                    <span className="aside">{sky(wx.weather.now.code)[0]!.toUpperCase() + sky(wx.weather.now.code).slice(1)}</span>
                  </span>
                </span>
                <span className="small">
                  {wx.matters.length ? wx.matters.join(" ") : (sit?.weather?.line ?? "Nothing unusual.")}
                  {nowMs - wx.weather.at > 90 * 60_000 && (
                    <span className="aside">
                      {" "}
                      As of{" "}
                      {new Date(wx.weather.at).toLocaleString(
                        [],
                        new Date(wx.weather.at).toDateString() === new Date(nowMs).toDateString()
                          ? { hour: "numeric", minute: "2-digit" }
                          : { weekday: "long", hour: "numeric", minute: "2-digit" },
                      )}
                      .
                    </span>
                  )}
                </span>
                {hours.length >= 3 && (
                  <div className="wx-bars" aria-hidden>
                    {hours.map((h) => (
                      <span
                        key={h.t}
                        className="wx-col"
                        title={`${new Date(h.t).toLocaleTimeString([], { hour: "numeric" })}: ${temp(h.temp_c, u)}, ${h.pop}% rain`}
                      >
                        {h.pop >= 20 && <i className="rain" style={{ height: `${Math.round(h.pop / 5)}px` }} />}
                        <i className="t" style={{ height: `${6 + ((h.temp_c - tMin) / Math.max(1, tMax - tMin)) * 16}px` }} />
                      </span>
                    ))}
                  </div>
                )}
                {hours.length >= 3 && (
                  <span className="row aside" style={{ justifyContent: "space-between" }}>
                    <span>Now</span>
                    {hours[8] && <span>{new Date(hours[8].t).toLocaleTimeString([], { hour: "numeric" })}</span>}
                    {hours[16] && <span>{new Date(hours[16].t).toLocaleTimeString([], { hour: "numeric" })}</span>}
                  </span>
                )}
              </>
            ) : (
              <span className="muted">{wx?.error ?? sit?.weather?.line ?? "Looking."}</span>
            )}
          </div>
          <div className="card2 pad now-card">
            <div className="card-head">
              <span className="h2">Needs you</span>
              <span className="grow" />
              {inbox.length > 0 && <span className="mono small ac">{inbox.length}</span>}
            </div>
            {inbox.slice(0, 2).map((i) => (
              <div key={i.id} className="need">
                <span className="sq-ac" />
                <span className="grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }} className="clip">
                    {i.title}
                  </span>
                  <span className="aside clamp">{i.text}</span>
                </span>
                <a className="btn s" href="#/inbox" style={{ textDecoration: "none" }}>
                  {i.kind === "approval" ? "Review" : i.kind === "face" || i.kind === "question" ? "Answer" : "Open"}
                </a>
              </div>
            ))}
            {!inbox.length && <span className="muted">Nothing is waiting on you.</span>}
            <span className="aside row" style={{ marginTop: "auto", gap: 6, paddingTop: 8, borderTop: "1px dashed var(--sep)" }}>
              {running.length ? (
                <>
                  <span className="mono spin" aria-hidden style={{ color: "var(--ac)", width: 9 }} />
                  {running.length} {running.length === 1 ? "job" : "jobs"} running: {running.map((j) => j.title).join(", ")}
                </>
              ) : (
                "No jobs running."
              )}
              {stuck.length > 0 && (
                <span className="err">
                  {" "}
                  · {stuck.length} stalled: {stuck.map((j) => j.title).join(", ")}
                </span>
              )}
            </span>
          </div>
        </div>
        {cal && !cal.error && (
          <div className="now-week">
            <span className="h2" style={{ fontSize: 14 }}>
              This week
            </span>
            {/* Each day's bar stacks its events by area (from the calendar's name); an event in no area is neutral. */}
            <span className="week-bars" aria-hidden>
              {load.map((n, i) => (
                <span key={i} className="wk">
                  {n ? (
                    <span className="wk-stack" style={{ height: 6 + (n / max) * 24 }}>
                      {days[i]!.map((e) => {
                        const a = eventArea(e, s.areas);
                        return <i key={e.id} style={{ flex: 1, background: a ? areaColor(a) : "var(--tx3)" }} />;
                      })}
                    </span>
                  ) : (
                    <i style={{ height: 3, background: "var(--sep2)" }} />
                  )}
                  <span className={`aside ${i === (today.getDay() + 6) % 7 ? "today" : ""}`}>
                    {i === (today.getDay() + 6) % 7 ? "Today" : addDays(monday, i).toLocaleDateString([], { weekday: "short" })}
                  </span>
                </span>
              ))}
            </span>
            <span className="grow" />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              {load[busiest]! > 0 && <span>{addDays(monday, busiest).toLocaleDateString([], { weekday: "long" })} is the busy one.</span>}
              <span className="row" style={{ gap: 6 }}>
                {(scoped ? [scoped] : s.areas.filter((a) => a.state === "active").slice(0, 5)).map((a) => (
                  <AreaTag key={a.id} area={a} />
                ))}
              </span>
            </span>
            {at("developer") && <span className="mono aside">{(cal.events ?? []).length} events</span>}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function WeekTab({ atlas }: { atlas: Atlas }) {
  const [offset, setOffset] = useState(0);
  const start = addDays(weekStart(new Date()), offset * 7);
  const cal = useCalendar(atlas, `week:${offset}`, start, addDays(start, 7));
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">{offset === 0 ? "This week" : offset === 1 ? "Next week" : offset === -1 ? "Last week" : "Week"}</h1>
          <span className="muted">
            {start.toLocaleDateString([], { month: "short", day: "numeric" })} to{" "}
            {addDays(start, 6).toLocaleDateString([], { month: "short", day: "numeric" })}
          </span>
          <span className="grow" />
          <button className="btn sm" onClick={() => setOffset(offset - 1)}>
            Earlier
          </button>
          {offset !== 0 && (
            <button className="btn sm" onClick={() => setOffset(0)}>
              This week
            </button>
          )}
          <button className="btn sm" onClick={() => setOffset(offset + 1)}>
            Later
          </button>
        </div>
        <CalendarNote atlas={atlas} cal={cal} />
        <WeekGrid events={cal?.events ?? []} agenda={atlas.state.agenda} start={start} areas={atlas.state.areas} />
      </div>
    </Sheet>
  );
}

/** How far off something is, in a few words: "in 40 min", "tomorrow at 9:00 AM", "Sunday, in 2 days". */
function until(d: Date, allDay: boolean, now: number): string {
  const ms = d.getTime() - now;
  const days = Math.round((startOfDay(d).getTime() - startOfDay(new Date(now)).getTime()) / 86_400_000);
  if (!allDay && ms > 0 && ms < 60 * 60_000) return `In ${Math.max(1, Math.round(ms / 60_000))} min`;
  const at = allDay ? "" : ` at ${clock(d)}`;
  if (!allDay && ms <= 0) return `Started at ${clock(d)}`;
  if (days <= 0) return allDay ? "Today" : `Today${at}, in ${Math.round(ms / 3_600_000)} h`;
  if (days === 1) return `Tomorrow${at}`;
  return `${dayName(d)}${at}, in ${days} days`;
}

/** A receipt opened on the stage (§21.8: a receipt unfolds into its full view). */
function ReceiptView({ atlas, row }: { atlas: Atlas; row: LogRow }) {
  const runId = row.run_id;
  useEffect(() => {
    if (runId) atlas.send({ type: "atlas.run.detail", run_id: runId });
  }, [runId]);
  const detail = runId ? atlas.state.runDetail[runId] : undefined;
  const callId = row.body.call_id;
  const call = detail?.rows.find((r) => r.kind === "tool.call" && r.body.call_id === callId);
  const asked = detail?.rows.find((r) => r.kind === "message.in");
  const receipt = row.body.receipt as { text: string; undo?: unknown };
  const undone = atlas.state.rows.some((r) => r.body.undo_of === row.id);
  const { at } = useDetail();
  const tech = at("developer");
  return (
    <Sheet className="pick">
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">{receipt.text}</h1>
          {undone && <span className="tag">Undone</span>}
          <span className="grow" />
          {receipt.undo != null && !undone && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.undo", log_id: row.id })}>
              Undo
            </button>
          )}
        </div>
        {!tech && (
          <div className="kv">
            <span className="lab">Asked by</span>
            <span>{asked ? `You · ${clock(asked.at)} · “${String(asked.body.text ?? "")}”` : "Atlas, on its own"}</span>
            <span className="lab">Undo</span>
            <span>{receipt.undo != null ? (undone ? "Undone" : "You can undo this") : "Nothing to undo"}</span>
          </div>
        )}
        {tech && (
          <>
            <div className="chain" style={{ marginBottom: 16 }}>
              <span className="tag">You · {asked?.surface === "voice" ? "voice" : "chat"}</span>
              <span className="dash" />
              <span className="tag">Atlas</span>
              <span className="dash" />
              <span className={`tag ${row.body.ok === false ? "ac" : "ok"}`}>
                {row.body.ok === false ? "×" : "✓"} {String(row.body.name ?? "")}
              </span>
            </div>
            <div className="kv">
              <span className="lab">Asked by</span>
              <span>{asked ? `You · ${clock(asked.at)} · “${String(asked.body.text ?? "")}”` : "Atlas"}</span>
              <span className="lab">Did</span>
              <span className="mono small">{String(row.body.name ?? "")}</span>
              {call && (
                <>
                  <span className="lab">With</span>
                  <span className="mono small" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {JSON.stringify(call.body.input, null, 1)}
                  </span>
                </>
              )}
              <span className="lab">Result</span>
              <span className="mono small" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {String(row.body.output ?? "")}
              </span>
              <span className="lab">Undo</span>
              <span>{receipt.undo != null ? (undone ? "Done" : "Available") : "Nothing to undo"}</span>
              <span className="lab">Run</span>
              <span className="mono small">{runId}</span>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** An approval card on the stage. Once it's answered, the stage says how it went. */
function ApprovalTab({ atlas, id }: { atlas: Atlas; id: string }) {
  const item = atlas.state.inbox?.find((i) => i.id === id && i.approval);
  const settled = [...atlas.state.rows].reverse().find((r) => r.kind === "agenda.change" && r.body.item_id === id);
  return (
    <Sheet className="pick">
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">{item?.title ?? String(settled?.body.title ?? "Approval")}</h1>
          <span className={`tag ${item ? "ac" : ""}`}>{item ? "Waiting for your OK" : settledText(settled)}</span>
        </div>
        {item?.approval ? (
          <ApprovalCard atlas={atlas} a={item.approval} />
        ) : (
          <p className="muted wrap-anywhere">{settled ? <InlineText text={settledDetail(settled)} /> : "It isn't waiting any more."}</p>
        )}
      </div>
    </Sheet>
  );
}

const settledText = (r: LogRow | undefined) =>
  !r ? "Settled" : r.body.change === "done" ? "Approved" : r.body.change === "cancelled" ? "Declined" : "Ran out";

function settledDetail(r: LogRow): string {
  if (r.body.change === "done") return (Array.isArray(r.body.results) ? r.body.results.map(String) : []).join(" ") || "Done.";
  if (r.body.change === "cancelled") return "You declined, so nothing was done.";
  return "Nobody answered in time, so nothing was done.";
}
