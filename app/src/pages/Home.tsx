// Home (§21.2): the stage and the console. The stage shows Now, the Week,
// helpers' Jobs, and whatever a receipt opens into.

import { useEffect, useState } from "react";
import type { LogRow } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Console, VoiceStrip } from "../Shell";
import { addDays, AsciiDiamond, clock, dayName, Empty, Sheet, shortDay, Stage, startOfDay, useNow } from "../ui";
import { eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

type HomeTab = "now" | "week" | "jobs" | "receipt";

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
  const [tab, setTab] = useState<HomeTab>("now");
  const [job, setJob] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LogRow | null>(null);

  // A job picked from the toolbar arrives in the address: "jobs:<id>".
  useEffect(() => {
    if (detail.startsWith("jobs:")) {
      setTab("jobs");
      setJob(detail.slice(5));
    }
  }, [detail]);

  const running = s.jobs.filter((j) => j.state === "running").length;
  const now = useNow();
  const tz = s.view?.settings.timezone;
  const meta =
    tab === "week"
      ? `Calendar · ${s.view?.secrets.icloud ? "iCloud" : "not connected"}`
      : `${dayName(now)} · ${clock(now)}${tz ? ` · ${tz}` : ""}`;

  return (
    <Stage
      label="Stage"
      home
      tabs={[
        { id: "now", label: "Now" },
        { id: "week", label: "Week" },
        { id: "jobs", label: "Jobs", badge: running || null },
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
  const reminder = s.agenda.find((a) => a.kind === "reminder" && a.state === "scheduled");
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
                <p className="muted">Reminder, {shortDay(reminder.due_at)}</p>
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
        {cal?.error && (
          <p className={`small ${atlas.state.view?.secrets.icloud ? "err" : "muted"}`} style={{ marginBottom: 10 }}>
            {cal.error}
          </p>
        )}
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
