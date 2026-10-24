// Home (§21.2): the stage and the console. The stage shows Now, the Week,
// helpers' Jobs, the views Atlas shows (§21.6), and whatever a receipt opens into.

import { InlineText } from "../Markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JobView, LogRow } from "../../../core/src/protocol";
import type { StageView } from "../../../core/src/stage";
import type { Atlas } from "../connection";
import { Console, VoiceStrip } from "../Shell";
import { type Shown, shownFrom, StageSheet, titleOf } from "../StageViews";
import { MapCanvas, whereLine } from "../SenseViews";
import { sky, temp } from "../../../core/src/weather";
import { useDetail } from "../theme";
import { ApprovalCard } from "../Approval";
import {
  addDays,
  areaColor,
  AreaTag,
  AsciiDiamond,
  clock,
  dayName,
  Diamond,
  type DiamondState,
  Empty,
  Icon,
  Sheet,
  shortDay,
  Stage,
  startOfDay,
  StateDot,
  useNow,
} from "../ui";
import { CalendarNote, eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

type HomeTab = "now" | "week" | "jobs" | "receipt" | "approval" | `view:${string}`;

/** The approval a receipt waits on, if it does. */
const approvalOf = (r: LogRow) => (r.body.receipt as { approval?: string } | undefined)?.approval ?? null;

/** The most views the stage keeps open as tabs; the oldest closes first. */
const MAX_VIEWS = 4;

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
 * What's on Home's stage, kept while the app is open (and through a reload,
 * in this tab), so leaving Home and coming back finds it as it was. `seen`
 * is the last log row the stage has looked at for new views.
 */
interface Kept {
  tab: HomeTab;
  views: Shown[];
  approval: string | null;
  seen: number | null;
}
const KEPT_KEY = "atlas.stage";
let kept: Kept = (() => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEPT_KEY) ?? "null") as Kept | null;
    if (v && Array.isArray(v.views)) return v;
  } catch {
    // No storage here (a private window): the stage starts empty.
  }
  return { tab: "now", views: [], approval: null, seen: null };
})();
function keep(next: Kept): void {
  kept = next;
  try {
    sessionStorage.setItem(KEPT_KEY, JSON.stringify(next));
  } catch {
    // Too big or not allowed: it's still kept for this visit.
  }
}

export function Home({
  atlas,
  detail,
  go,
  onTranscript,
}: {
  atlas: Atlas;
  detail: string;
  go: (d: string) => void;
  onTranscript: () => void;
}) {
  const s = atlas.state;
  // The stage outlives a visit to another page: its views and tab come back with Home.
  const [tab, setTab] = useState<HomeTab>(() => kept.tab);
  const [job, setJob] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LogRow | null>(null);
  const [views, setViews] = useState<Shown[]>(() => kept.views);
  const [approval, setApproval] = useState<string | null>(() => kept.approval);
  useEffect(() => {
    keep({ tab: tab === "receipt" ? "now" : tab, views, approval, seen: kept.seen });
  }, [tab, views, approval]);
  const openApproval = (id: string) => {
    setApproval(id);
    setTab("approval");
  };

  // Showing the same thing again (the workspace, a file, an area) reuses its tab, in its place, instead of adding one.
  const openView = (v: Shown) => {
    const matches = (x: Shown) => x.id === v.id || sameThing(x, v);
    const at = views.find(matches)?.id ?? v.id;
    setViews((list) => {
      const same = list.find(matches);
      return same ? list.map((x) => (x === same ? { ...v, id: same.id } : x)) : [...list, v].slice(-MAX_VIEWS);
    });
    setTab(`view:${at}`);
  };
  const closeView = (id: string) => {
    setViews((list) => list.filter((x) => x.id !== id));
    if (tab === `view:${id}`) setTab("now");
  };

  // A job picked from the toolbar arrives in the address as "jobs:<id>"; a view opened from elsewhere as "view:<receipt id>".
  useEffect(() => {
    if (detail.startsWith("jobs:")) {
      setTab("jobs");
      setJob(detail.slice(5));
    } else if (detail.startsWith("view:")) {
      const id = detail.slice(5);
      const row = s.rows.find((r) => r.id === id) ?? s.history?.rows.find((r) => r.id === id);
      const shown = row && shownFrom(row);
      if (shown) openView(shown);
      go("");
    }
  }, [detail]);

  // A view Atlas shows goes straight onto the stage (§21.6), including one shown while another page was open.
  // Views already in the thread when the app opened stay behind their receipts.
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
    // A card waiting for your OK comes onto the stage too (§12.2).
    const asking = fresh
      .map(approvalOf)
      .filter((a): a is string => a != null)
      .at(-1);
    if (asking) openApproval(asking);
  }, [s.rows, s.loaded]);

  const running = s.jobs.filter((j) => j.state === "running").length;
  const now = useNow();
  const tz = s.view?.settings.timezone;
  const shownTab = views.find((v) => tab === `view:${v.id}`);
  const meta =
    tab === "week"
      ? `Calendar · ${s.view?.calendar.provider ? s.view.calendar.provider.name : "not connected"}`
      : shownTab
        ? shownTab.view.kind === "area" || shownTab.view.kind === "person"
          ? "Live from what Atlas knows"
          : "Put together by Atlas"
        : `${dayName(now)} · ${clock(now)}${tz ? ` · ${tz}` : ""}`;

  return (
    <Stage
      label="Stage"
      home
      tabs={[
        { id: "now", label: "Now" },
        { id: "week", label: "Week" },
        { id: "jobs", label: "Jobs", badge: running || null },
        ...views.map((v) => ({ id: `view:${v.id}` as const, label: titleOf(atlas, v) })),
        ...(approval ? [{ id: "approval" as const, label: "Your OK" }] : []),
        ...(receipt ? [{ id: "receipt" as const, label: "Receipt" }] : []),
      ]}
      tab={tab}
      onTab={(t) => {
        setTab(t);
        if (t !== "jobs") go("");
      }}
      meta={meta}
      dock={
        <div className="dock">
          {atlas.inCall && <VoiceStrip atlas={atlas} />}
          <Console
            atlas={atlas}
            onTranscript={onTranscript}
            onReceipt={(r) => {
              const shown = shownFrom(r);
              if (shown) return openView(shown);
              const asking = approvalOf(r);
              if (asking) return openApproval(asking);
              setReceipt(r);
              setTab("receipt");
            }}
          />
        </div>
      }
    >
      {tab === "now" && (
        <Now atlas={atlas} showSituation={() => openView({ id: "local:situation", view: { kind: "situation" }, title: "Situation" })} />
      )}
      {tab === "week" && <WeekTab atlas={atlas} />}
      {tab === "jobs" && <Jobs atlas={atlas} selected={job} onSelect={setJob} />}
      {tab === "receipt" && receipt && <ReceiptView atlas={atlas} row={receipt} />}
      {tab === "approval" && approval && <ApprovalTab atlas={atlas} id={approval} />}
      {views
        .filter((v) => tab === `view:${v.id}`)
        .map((v) => (
          <StageSheet
            key={v.id}
            atlas={atlas}
            shown={v}
            onClose={() => closeView(v.id)}
            onOpen={(view: StageView, title: string) => openView({ id: `local:${JSON.stringify(view)}`, view, title })}
          />
        ))}
    </Stage>
  );
}

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

/** What the diamond is doing: listening, thinking or speaking in a call, thinking while a run is under way, idle otherwise. */
function diamondState(atlas: Atlas): DiamondState {
  if (atlas.inCall) {
    const v = atlas.voice.status;
    return v === "listening" || v === "thinking" || v === "speaking" ? v : "idle";
  }
  return Object.values(atlas.state.live).some((l) => l.surface !== "voice") ? "thinking" : "idle";
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
  const running = s.jobs.filter((j) => j.state === "running");
  const scoped = s.areas.find((a) => a.id === s.scope);
  const load = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    const e = addDays(d, 1);
    return (cal?.events ?? []).filter((x) => eventStart(x) < e && eventEnd(x) > d).length;
  });
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
    .filter((r) => r.kind === "tool.result" && r.body.receipt && r.body.ok !== false && r.at >= today.getTime())
    .slice(-2)
    .reverse();
  const u = wx?.units ?? sit?.units ?? "metric";
  const hours = (wx?.weather?.hours ?? []).filter((h) => h.t > Date.now() - 3_600_000).slice(0, 24);
  const tMax = Math.max(...hours.map((h) => h.temp_c), 1);
  const tMin = Math.min(...hours.map((h) => h.temp_c), 0);
  const travel = sit?.next?.travel && next && sit.next.title === next.title ? sit.next.travel : null;
  const point = sit?.where.known ? sit.where.point : null;
  // On a phone the diamond is smaller, so what's next shows without scrolling.
  const narrow = useMemo(() => window.matchMedia("(max-width: 760px)").matches, []);

  return (
    <Sheet>
      <div className="sheet-in now">
        <div className="now-head">
          <AsciiDiamond height={narrow ? 140 : 280} level={atlas.inCall ? atlas.voice.level : 0} state={diamondState(atlas)} />
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
              {next && (
                <span className="aside">
                  {next.all_day ? dayName(eventStart(next)) : `${shortDay(eventStart(next))} · ${clock(eventStart(next))}`}
                </span>
              )}
            </div>
            {next ? (
              <>
                <span style={{ fontWeight: 500, fontSize: 15 }}>{next.title}</span>
                {next.location && <span className="aside clip">{next.location}</span>}
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
            </span>
          </div>
        </div>
        {cal && !cal.error && (
          <div className="now-week">
            <span className="h2" style={{ fontSize: 14 }}>
              This week
            </span>
            {/* TODO(core): events carry no areas yet, so each day's bar is one color: the scoped area's, else neutral. Stacked by area once they do. */}
            <span className="week-bars" aria-hidden>
              {load.map((n, i) => (
                <span key={i} className="wk">
                  <i
                    style={{
                      height: n ? 6 + (n / max) * 24 : 3,
                      background: n ? (scoped ? areaColor(scoped) : "var(--tx3)") : "var(--sep2)",
                    }}
                  />
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
        <WeekGrid events={cal?.events ?? []} agenda={atlas.state.agenda} start={start} />
      </div>
    </Sheet>
  );
}

function Jobs({ atlas, selected, onSelect }: { atlas: Atlas; selected: string | null; onSelect: (id: string) => void }) {
  const jobs = atlas.state.jobs;
  const job = jobs.find((j) => j.id === selected) ?? jobs[0];
  useEffect(() => {
    if (job?.run_id) atlas.send({ type: "atlas.run.detail", run_id: job.run_id });
  }, [job?.id, job?.steps, job?.state]);
  if (!job) {
    return (
      <Sheet>
        <Empty title="No jobs right now">
          When something needs a lot of looking, Atlas hands it to a helper and you can watch it here.
        </Empty>
      </Sheet>
    );
  }
  const detail = job.run_id ? atlas.state.runDetail[job.run_id] : undefined;
  const lookups = (detail?.rows ?? []).filter((r) => r.kind === "tool.call");
  if (job.coding) return <CodingJob atlas={atlas} jobs={jobs} job={job} onSelect={onSelect} />;
  const goal = job.goal;
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="tabs" style={{ marginBottom: 16 }}>
          {jobs.map((j) => (
            <button key={j.id} className={j.id === job.id ? "on" : ""} onClick={() => onSelect(j.id)}>
              {j.state === "running" && <span className="mono spin" aria-hidden />}
              {j.title}
            </button>
          ))}
        </div>
        <div className="sheet-title">
          <h1 className="disp">{job.title}</h1>
          <span className={`tag ${job.state === "running" ? "ac" : job.state === "done" ? "ok" : ""}`}>{job.state}</span>
          <span className="grow" />
          {job.state === "running" && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.job.stop", id: job.id })}>
              Stop
            </button>
          )}
        </div>
        <div className="kv">
          <span className="lab">Asked</span>
          <span style={{ whiteSpace: "pre-wrap" }}>{job.brief}</span>
          <span className="lab">Started</span>
          <span>{shortDay(job.started_at)}</span>
          <span className="lab">Now</span>
          <span>
            {job.state === "running"
              ? (job.status ?? "Working")
              : job.state === "done"
                ? "Finished"
                : job.state === "failed"
                  ? "Didn't finish"
                  : "Stopped"}
          </span>
        </div>
        {goal && <GoalPlan atlas={atlas} job={job} />}
        {lookups.length > 0 && (
          <>
            <div className="section-rule">
              <span className="lab">Lookups · {lookups.length}</span>
            </div>
            <div className="rows">
              {lookups.map((r) => (
                <div className="r small" key={r.id}>
                  <span className="mono faint">{clock(r.at)}</span>
                  <span className="mono">{String(r.body.name)}</span>
                  <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {JSON.stringify(r.body.input)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {job.result && (
          <>
            <div className="section-rule">
              <span className="lab">{job.state === "done" ? "Handed back" : "Why"}</span>
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{job.result}</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * A job Atlas owns (§8.3): its plan with each step's state and brain, what
 * it waits on, what it has used, the files it kept, and Steer.
 */
function GoalPlan({ atlas, job }: { atlas: Atlas; job: JobView }) {
  const g = job.goal!;
  const [steer, setSteer] = useState("");
  const mark = { todo: "·", doing: "▸", done: "✓", failed: "×", skipped: "–" } as const;
  return (
    <>
      <div className="section-rule">
        <span className="lab">The plan</span>
        <span className="grow" />
        <span className="aside">
          {g.spent.steps} of {g.budget.steps} steps · {g.spent.looks} of {g.budget.looks} looks
        </span>
      </div>
      <div className="rows">
        {g.plan.map((s) => (
          <div className="r small" key={s.id}>
            <span className="mono faint" style={{ width: 14 }}>
              {mark[s.state]}
            </span>
            <span className={s.state === "doing" ? "" : s.state === "todo" ? "muted" : ""} style={{ flex: 1 }}>
              {s.title}
              {s.kind === "checkpoint" && <span className="aside"> · your look</span>}
            </span>
            {s.brain && s.brain !== "Main" && <span className="aside">{s.brain}</span>}
          </div>
        ))}
      </div>
      {g.question && (
        <div className="card2 pad" style={{ marginTop: 12 }}>
          <p style={{ fontWeight: 500 }}>{g.question.text}</p>
          {g.question.content && <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{g.question.content}</p>}
          <p className="aside" style={{ marginTop: 8 }}>
            Answer it in Inbox, or below.
          </p>
        </div>
      )}
      {Object.keys(g.spent.by).length > 0 && (
        <p className="aside" style={{ marginTop: 8 }}>
          Steps by brain:{" "}
          {Object.entries(g.spent.by)
            .map(([b, n]) => `${b} ${n}`)
            .join(", ")}
        </p>
      )}
      {g.files.length > 0 && <p className="aside">Kept in Library: {g.files.join(", ")}</p>}
      {job.state === "running" && (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!steer.trim()) return;
            atlas.send({ type: "atlas.job.say", id: job.id, text: steer.trim() });
            setSteer("");
          }}
        >
          <input
            className="grow"
            placeholder={g.question ? "Your answer" : "Steer: a word for its next step"}
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!steer.trim()}>
            {g.question ? "Answer" : "Steer"}
          </button>
        </form>
      )}
      <p className="aside mono" style={{ marginTop: 6 }}>
        {g.folder}
      </p>
    </>
  );
}

/** One line of a coding job's stream, as its terminal shows it. */
function streamLine(e: NonNullable<JobView["coding"]>["log"][number]): { mark: string; who: string; text: string; tone: string } {
  const first = e.text.split("\n").find((l) => l.trim()) ?? "";
  if (e.who === "tool")
    return {
      mark: e.status === "failed" ? "×" : e.status === "completed" ? "✓" : "▸",
      who: "run",
      text: first,
      tone: e.status === "failed" ? "var(--ac)" : e.status === "completed" ? "var(--tx2)" : "var(--tx)",
    };
  if (e.who === "agent") return { mark: first.trim().endsWith("?") ? "?" : "›", who: "agent", text: first, tone: "var(--tx)" };
  if (e.who === "atlas") return { mark: "◆", who: "atlas", text: first, tone: "var(--tx)" };
  if (e.who === "owner") return { mark: "◆", who: "you", text: first, tone: "var(--tx)" };
  if (e.who === "plan") return { mark: "·", who: "plan", text: first, tone: "var(--tx3)" };
  return { mark: "·", who: "note", text: first, tone: "var(--tx3)" };
}

/**
 * A coding job (§8.2, §21.4, docs/ui 05): its steps, the agent's stream as a
 * terminal, the questions Atlas answered for the owner with their sources,
 * what waits on the owner, and Steer and Stop.
 */
export function CodingJob({ atlas, jobs, job, onSelect }: { atlas: Atlas; jobs: JobView[]; job: JobView; onSelect: (id: string) => void }) {
  const c = job.coding!;
  const [steer, setSteer] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const term = useRef<HTMLDivElement>(null);
  useEffect(() => {
    term.current?.scrollTo({ top: term.current.scrollHeight });
  }, [c.log.length]);
  const now = useNow(30_000);
  const minutes = Math.max(0, Math.round((now - job.started_at) / 60_000));
  const running = job.state === "running";
  const forYou = c.answers.filter((a) => a.source !== "you");
  const askedYou = c.answers.length - forYou.length + (c.question ? 1 : 0);
  const say = (text: string) => atlas.send({ type: "atlas.job.say", id: job.id, text });
  const lastTool = [...c.log].reverse().find((e) => e.who === "tool" && e.out);
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="row" style={{ marginBottom: 16, flexWrap: "nowrap" }}>
          <div className="tabs grow">
            {jobs.map((j) => (
              <button key={j.id} className={j.id === job.id ? "on" : ""} onClick={() => onSelect(j.id)}>
                {j.state === "running" && <span className="mono spin" aria-hidden />}
                {j.title}
              </button>
            ))}
          </div>
          <span className="mono faint small">
            {c.cost != null ? `$${c.cost.toFixed(2)}${c.cap != null ? ` of $${c.cap.toFixed(0)}` : ""} · ` : ""}
            {minutes} MIN
          </span>
          {running && (
            <button className="btn" onClick={() => setSteer(steer == null ? "" : null)} aria-expanded={steer != null}>
              Steer
            </button>
          )}
          {running && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.job.stop", id: job.id })}>
              Stop
            </button>
          )}
        </div>
        <div className="row" style={{ alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <h1 className="disp" style={{ fontSize: 21 }}>
            {job.title}
          </h1>
          <span className="faint">
            {c.repo} · {c.agent} does the work, Atlas runs it
          </span>
        </div>
        <div className="chain" style={{ marginBottom: 14 }}>
          {c.steps.map((st, i) => (
            <span key={st.name} style={{ display: "contents" }}>
              {i > 0 && <span className="dash" />}
              <span
                className={`tag ${st.state === "now" ? "ac" : ""}`}
                style={st.state === "todo" ? { borderStyle: "dashed", opacity: 0.7 } : {}}
              >
                {st.state === "done" ? "✓ " : st.state === "now" ? "● " : "→ "}
                {st.name === "PR" ? "PR to Inbox" : st.name}
              </span>
            </span>
          ))}
          {!running && (
            <span className={`tag ${job.state === "done" ? "ok" : "ac"}`}>
              {job.state === "done" ? "done" : job.state === "failed" ? "didn't finish" : "stopped"}
            </span>
          )}
        </div>
        {steer != null && (
          <form
            className="row"
            style={{ marginBottom: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (steer.trim()) say(steer.trim());
              setSteer(null);
            }}
          >
            <input
              autoFocus
              className="grow"
              placeholder="Tell the agent, such as: use the existing date helper"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
            />
            <button className="btn primary" type="submit" disabled={!steer.trim()}>
              Send
            </button>
          </form>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)", gap: 14 }}>
          <div
            ref={term}
            className="mono"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--sep)",
              borderRadius: 8,
              padding: "12px 14px",
              fontSize: 11.5,
              lineHeight: 1.75,
              color: "var(--tx2)",
              maxHeight: 420,
              overflow: "auto",
            }}
          >
            <div style={{ color: "var(--tx3)" }}>
              $ {c.agent.toLowerCase()} · {c.repo} ·{" "}
              {c.branch_link ? (
                <a href={c.branch_link} target="_blank" rel="noreferrer">
                  {c.branch}
                </a>
              ) : (
                c.branch
              )}
            </div>
            {c.log.map((e, i) => {
              const l = streamLine(e);
              return (
                <div key={i} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: l.tone }} title={e.text}>
                  {l.mark} <span style={{ color: "var(--tx3)" }}>{l.who.padEnd(6, " ")}</span> {l.text}
                </div>
              );
            })}
            {lastTool?.out && running && (
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  color: "var(--tx3)",
                  borderTop: "1px dashed var(--dash)",
                  marginTop: 6,
                  paddingTop: 6,
                }}
              >
                {lastTool.out.trim().split("\n").slice(-8).join("\n")}
              </div>
            )}
            {running && (
              <span className="blink" style={{ color: "var(--tx)" }}>
                {" "}
                _
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {c.question && (
              <div
                style={{
                  border: "1px solid var(--ac)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <span className="lab ac">Waiting on you</span>
                <span>{c.question.text}</span>
                {c.question.why && <span className="muted small">{c.question.why}</span>}
                {c.question.site ? (
                  <a className="btn" href="#/inbox">
                    Answer in Inbox
                  </a>
                ) : (
                  <>
                    {c.question.options.length > 0 && (
                      <div className="row">
                        {c.question.options.map((o, n) => (
                          <button key={o} className={`btn ${n === 0 ? "primary" : ""}`} onClick={() => say(o)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (answer.trim()) say(answer.trim());
                        setAnswer("");
                      }}
                    >
                      <input className="grow" placeholder="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                      <button className="btn" type="submit" disabled={!answer.trim()}>
                        Answer
                      </button>
                    </form>
                  </>
                )}
              </div>
            )}
            <div
              style={{
                border: "1px solid var(--sep)",
                borderRadius: 8,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <span className="lab grow">Atlas answered for you</span>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {forYou.length} · ASKED YOU {askedYou}
                </span>
              </div>
              {!forYou.length && (
                <span className="muted small">
                  Nothing yet. Routine questions from the agent get answered here, each with where the answer came from.
                </span>
              )}
              {forYou.map((a, i) => (
                <div
                  key={i}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8, borderTop: "1px dashed var(--dash)" }}
                >
                  <span className="small" style={{ color: "var(--tx2)" }}>
                    {a.q}
                  </span>
                  <span className="row small" style={{ gap: 8, alignItems: "flex-start", flexWrap: "nowrap" }}>
                    <Diamond size={10} />
                    <span>{a.a}</span>
                  </span>
                  <span className="mono faint" style={{ fontSize: 10.5 }}>
                    FROM {a.source.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
            {c.pr && (
              <div
                style={{
                  border: "1px solid var(--sep)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <span className="lab">Pull request</span>
                <a href={c.pr.link} target="_blank" rel="noreferrer">
                  {c.pr.title}
                </a>
                <span className="muted small">Nothing is merged until you do.</span>
              </div>
            )}
            {c.error && (
              <div
                style={{
                  border: "1px solid var(--ac)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <span className="lab ac">Why it stopped</span>
                <span className="small">{c.error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
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
