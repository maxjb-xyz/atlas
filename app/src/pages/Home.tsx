// Home (§21.2): the stage and the console. The stage shows Now, the Week,
// helpers' Jobs, the views Atlas shows (§21.6), and whatever a receipt opens into.

import { InlineText } from "../Markdown";
import { useEffect, useRef, useState } from "react";
import type { LogRow } from "../../../core/src/protocol";
import type { StageView } from "../../../core/src/stage";
import type { Atlas } from "../connection";
import { Console, VoiceStrip } from "../Shell";
import { type Shown, shownFrom, StageSheet, titleOf } from "../StageViews";
import { ApprovalCard } from "../Approval";
import { addDays, AsciiDiamond, clock, dayName, Empty, Sheet, shortDay, Stage, startOfDay, useNow } from "../ui";
import { CalendarNote, eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

type HomeTab = "now" | "week" | "jobs" | "receipt" | "approval" | `view:${string}`;

/** The approval a receipt waits on, if it does. */
const approvalOf = (r: LogRow) => (r.body.receipt as { approval?: string } | undefined)?.approval ?? null;

/** The most views the stage keeps open as tabs; the oldest closes first. */
const MAX_VIEWS = 4;

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

  const openView = (v: Shown) => {
    setViews((list) => [...list.filter((x) => x.id !== v.id), v].slice(-MAX_VIEWS));
    setTab(`view:${v.id}`);
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
      const row = s.rows.find((r) => r.id === detail.slice(5));
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
      ? `Calendar · ${s.view?.secrets.icloud ? "iCloud" : "not connected"}`
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
      {tab === "now" && <Now atlas={atlas} />}
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

function Now({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
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
  const load = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    const e = addDays(d, 1);
    return (cal?.events ?? []).filter((x) => eventStart(x) < e && eventEnd(x) > d).length;
  });
  const busiest = load.indexOf(Math.max(...load));
  const max = Math.max(1, ...load);
  const underway = next && !next.all_day && eventStart(next).getTime() <= Date.now();
  const line = underway
    ? `Now: ${next.title}, until ${clock(eventEnd(next))}.`
    : next
      ? `Nothing on the calendar until ${dayName(eventStart(next))}${next.all_day ? "" : ` at ${clock(eventStart(next))}`}.`
      : s.view?.secrets.icloud
        ? "Nothing on the calendar this week."
        : "Connect a calendar in Settings and I'll keep an eye on your week.";

  return (
    <Sheet>
      <div className="sheet-in">
        <div className="row" style={{ gap: 24, alignItems: "center", marginBottom: 24, flexWrap: "nowrap" }}>
          <AsciiDiamond level={atlas.inCall ? atlas.voice.level : 0} />
          <div>
            <h1 className="disp" style={{ fontSize: 30 }}>
              {greeting(new Date())}
              {owner ? `, ${owner}` : ""}.
            </h1>
            <p className="muted" style={{ fontSize: 15, marginTop: 4 }}>
              {line}
            </p>
          </div>
        </div>
        <div className="cells">
          <div className="cell">
            <span className="lab">Next</span>
            {next ? (
              <>
                <p style={{ fontWeight: 500, fontSize: 15 }}>{next.title}</p>
                <p className="muted">
                  {dayName(eventStart(next))}
                  {next.all_day ? ", all day" : `, ${clock(eventStart(next))}`}
                </p>
                {next.location && (
                  <p className="lab" style={{ marginTop: 6 }}>
                    {next.location}
                  </p>
                )}
              </>
            ) : reminder ? (
              <>
                <p style={{ fontWeight: 500, fontSize: 15 }}>{reminder.title}</p>
                <p className="muted">
                  {reminder.kind === "promise" ? "Atlas promised" : "Reminder"}, {shortDay(reminder.due_at)}
                </p>
              </>
            ) : (
              <p className="muted">{cal?.error ?? "Nothing coming up."}</p>
            )}
          </div>
          <div className="cell">
            <span className={`lab ${inbox.length ? "ac" : ""}`}>Needs you{inbox.length ? ` · ${inbox.length}` : ""}</span>
            {inbox.length ? (
              <>
                <p style={{ fontWeight: 500, fontSize: 15 }}>{inbox[0]!.title}</p>
                <p className="muted">
                  {inbox.length > 1 ? `and ${inbox.length - 1} more` : inbox[0]!.kind === "failed" ? "Didn't finish" : "Ready for review"}
                </p>
                <p className="lab" style={{ marginTop: 6 }}>
                  <a href="#/inbox">Open Inbox</a>
                </p>
              </>
            ) : (
              <p className="muted">Nothing is waiting on you.</p>
            )}
          </div>
          <div className="cell">
            <span className="lab">Jobs{running.length ? ` · ${running.length}` : ""}</span>
            {running.length ? (
              <>
                <p style={{ fontWeight: 500, fontSize: 15 }}>{running[0]!.title}</p>
                <p className="muted">{running[0]!.status ?? "Working"}</p>
                <p className="lab" style={{ marginTop: 6 }}>
                  {running[0]!.steps} lookups so far
                </p>
              </>
            ) : (
              <p className="muted">No helpers working right now.</p>
            )}
          </div>
        </div>
        {cal && !cal.error && (
          <div className="row" style={{ marginTop: 22, gap: 16 }}>
            <span className="lab">Week load</span>
            <span className="meter" aria-hidden>
              {load.map((n, i) => (
                <i key={i} style={{ height: 4 + (n / max) * 14, width: 8, background: i === busiest && n ? "var(--tx)" : "var(--tx3)" }} />
              ))}
            </span>
            <span className="lab">M T W T F S S</span>
            <span className="grow" />
            {load[busiest]! > 0 && (
              <span className="muted">
                {addDays(weekStart(new Date()), busiest).toLocaleDateString([], { weekday: "long" })} is the busy one.
              </span>
            )}
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
