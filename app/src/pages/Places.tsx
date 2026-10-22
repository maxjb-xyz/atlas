// Inbox, Agenda and Automations (§21.2).

import { useEffect, useState } from "react";
import type { CalendarEventView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Markdown } from "../Markdown";
import { Composer, compose } from "../Shell";
import { addDays, AreaChip, clock, dayName, Empty, pressable, Sheet, shortDay, Stage, startOfDay } from "../ui";
import { CalendarNote, eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

// --- Inbox: everything waiting on you ------------------------------------------------------

export function Inbox({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  const [tab, setTab] = useState<"all" | "review" | "failed">("all");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    atlas.send({ type: "atlas.inbox" });
  }, [atlas.voice.connected]);
  // Oldest first, one open at a time (docs/ui §3). The scope switcher narrows it to one area.
  const items = [...(s.inbox ?? [])].reverse().filter((i) => (tab === "all" || i.kind === tab) && (!s.scope || i.areas.includes(s.scope)));
  const current = items.find((i) => i.id === open) ?? items[0];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Keys on a focused control are that control's, and shortcuts with a modifier are someone else's.
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, button, a, [role=button], [contenteditable]")) return;
      const i = items.findIndex((x) => x.id === current?.id);
      if (e.key === "j") setOpen(items[Math.min(items.length - 1, i + 1)]?.id ?? null);
      if (e.key === "k") setOpen(items[Math.max(0, i - 1)]?.id ?? null);
      if (e.key === "Enter" && current) atlas.send({ type: "atlas.inbox.done", id: current.id });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [items, current]);

  return (
    <Stage
      label="Inbox"
      tabs={[
        { id: "all", label: "All", badge: s.inbox?.length || null },
        { id: "review", label: "Reviews", badge: s.inbox?.filter((i) => i.kind === "review").length || null },
        { id: "failed", label: "Didn't finish", badge: s.inbox?.filter((i) => i.kind === "failed").length || null },
      ]}
      tab={tab}
      onTab={setTab}
      meta="J and K to move · ⏎ done"
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Ask about any of these" />
        </div>
      }
    >
      <Sheet>
        <div className="sheet-in">
          <div className="sheet-title">
            <h1 className="disp">Waiting on you</h1>
            <span className="muted">
              {items.length ? `${items.length} ${items.length === 1 ? "thing" : "things"}` : "Empty is the goal."}
            </span>
          </div>
          {!items.length && (
            <Empty title="Nothing is waiting on you">Finished background work and anything that didn't finish land here.</Empty>
          )}
          <div className="rows">
            {items.map((i) => {
              const on = i.id === current?.id;
              return (
                <div
                  key={i.id}
                  className="r"
                  style={{ flexDirection: "column", alignItems: "stretch", gap: 8, cursor: "pointer" }}
                  {...pressable(() => setOpen(i.id))}
                >
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <span className={`tag ${i.kind === "failed" ? "ac" : ""}`}>
                      {i.kind === "failed" ? "Didn't finish" : "Ready for review"}
                    </span>
                    <span style={{ fontWeight: 500 }} className="grow">
                      {i.title}
                    </span>
                    <AreaChip ids={i.areas} areas={s.areas} />
                    <span className="mono faint small">{shortDay(i.at)}</span>
                  </div>
                  {on && (
                    <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="panel">{i.text ? <Markdown text={i.text} /> : "No details."}</div>
                      <div className="chain">
                        <span className="tag">{i.kind === "failed" ? "Atlas" : "Helper"}</span>
                        <span className="dash" />
                        <span className={`tag ${i.kind === "failed" ? "ac" : "ok"}`}>{i.kind === "failed" ? "× stopped" : "✓ done"}</span>
                        <span className="dash" />
                        <span className="tag ac">Your look</span>
                      </div>
                      <div className="row">
                        <button className="btn primary" onClick={() => atlas.send({ type: "atlas.inbox.done", id: i.id })}>
                          Done
                        </button>
                        <button className="btn" onClick={() => compose(`About "${i.title}": `)}>
                          Ask about this
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Sheet>
    </Stage>
  );
}

// --- Agenda: everything on a clock -----------------------------------------------------------

interface AgendaEntry {
  at: Date;
  allDay: boolean;
  kind: "Event" | "Reminder" | "Job";
  title: string;
  source: string;
  id: string;
}

export function Agenda({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  const [tab, setTab] = useState<"upcoming" | "week">("upcoming");
  const [day, setDay] = useState<string | null>(null);
  const today = startOfDay(new Date());
  const cal = useCalendar(atlas, "agenda", today, addDays(today, 14));
  const start = weekStart(new Date());
  const week = useCalendar(atlas, "week:0", start, addDays(start, 7));

  const entries: AgendaEntry[] = [
    ...(cal?.events ?? [])
      .filter((e: CalendarEventView) => eventEnd(e).getTime() > Date.now())
      .map((e) => ({ at: eventStart(e), allDay: e.all_day, kind: "Event" as const, title: e.title, source: e.calendar, id: e.id })),
    ...s.agenda
      // Notifications held for quiet hours are the outbox's, not something on your clock.
      .filter((a) => (a.state === "scheduled" || a.state === "running") && a.kind !== "notify")
      .map((a) => ({
        at: new Date(a.due_at),
        allDay: false,
        kind: a.kind === "job" ? ("Job" as const) : ("Reminder" as const),
        title: a.title,
        source: a.kind === "job" ? "Helper" : "Atlas",
        id: a.id,
      })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const strip = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const key = (d: Date) => startOfDay(d).toDateString();
  const shown = day ? entries.filter((e) => key(e.at) === day) : entries;
  const byDay = new Map<string, AgendaEntry[]>();
  for (const e of shown) byDay.set(key(e.at), [...(byDay.get(key(e.at)) ?? []), e]);

  return (
    <Stage
      label="Agenda"
      tabs={[
        { id: "upcoming", label: "Upcoming" },
        { id: "week", label: "Week" },
      ]}
      tab={tab}
      onTab={setTab}
      meta={s.view?.secrets.icloud ? "Calendar · iCloud" : "Calendar not connected"}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Move it, add a reminder, or ask what's coming" />
        </div>
      }
    >
      <Sheet>
        <div className="sheet-in">
          {tab === "week" ? (
            <>
              <div className="sheet-title">
                <h1 className="disp">This week</h1>
              </div>
              <CalendarNote atlas={atlas} cal={week} />
              <WeekGrid events={week?.events ?? []} agenda={s.agenda} start={start} />
            </>
          ) : (
            <>
              <div className="sheet-title">
                <h1 className="disp">Coming up</h1>
                <span className="muted">The next two weeks</span>
              </div>
              <div className="row" style={{ gap: 6, marginBottom: 16 }}>
                {strip.map((d) => {
                  const n = entries.filter((e) => key(e.at) === key(d)).length;
                  const on = day === key(d);
                  return (
                    <button
                      key={d.toISOString()}
                      className={`btn ${on ? "on" : ""}`}
                      style={{ flexDirection: "column", height: "auto", padding: "6px 10px", gap: 2, minWidth: 64 }}
                      onClick={() => setDay(on ? null : key(d))}
                    >
                      <span className="lab">{d.toLocaleDateString([], { weekday: "short" })}</span>
                      <span style={{ fontWeight: 600 }}>{d.getDate()}</span>
                      <span className="mono faint" style={{ fontSize: 10.5 }}>
                        {n || "·"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <CalendarNote atlas={atlas} cal={cal} />
              {!shown.length && <Empty title="Nothing on the clock">Events, reminders and Atlas's background jobs show here.</Empty>}
              {[...byDay].map(([d, list]) => (
                <div key={d}>
                  <div className="section-rule">
                    <span className="lab">{dayName(new Date(d))}</span>
                  </div>
                  <div className="rows">
                    {list.map((e) => (
                      <div key={`${e.kind}:${e.id}`} className="r">
                        <span className="mono faint small" style={{ width: 70 }}>
                          {e.allDay ? "All day" : clock(e.at)}
                        </span>
                        <span className={`tag ${e.kind === "Reminder" ? "ac" : ""}`} style={{ width: 76, justifyContent: "center" }}>
                          {e.kind === "Reminder" ? "◆ " : ""}
                          {e.kind}
                        </span>
                        <span className="grow">{e.title}</span>
                        <span className="faint small hide-phone">{e.source}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </Sheet>
    </Stage>
  );
}

// --- Automations ------------------------------------------------------------------------------

export function Automations({ atlas }: { atlas: Atlas }) {
  const reminders = atlas.state.agenda.filter((a) => a.kind === "reminder" && a.state === "scheduled");
  return (
    <Stage
      label="Automations"
      tabs={[{ id: "all", label: "All" }]}
      tab="all"
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Describe something for Atlas to do on its own" />
        </div>
      }
    >
      <Sheet>
        <div className="sheet-in">
          <div className="sheet-title">
            <h1 className="disp">What Atlas does on its own</h1>
          </div>
          <Empty title="No automations yet">
            Soon you'll be able to say "every weekday at 8, brief me on the day" and see it here as When → Do → Report, with a test run
            before it starts.
            {reminders.length > 0 && (
              <p style={{ marginTop: 10 }}>
                Today Atlas keeps {reminders.length} {reminders.length === 1 ? "reminder" : "reminders"}; they're in{" "}
                <a href="#/agenda">Agenda</a>.
              </p>
            )}
          </Empty>
        </div>
      </Sheet>
    </Stage>
  );
}
