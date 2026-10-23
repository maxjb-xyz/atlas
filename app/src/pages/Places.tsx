// Inbox and Agenda (§21.2). Automations has its own page.

import { useEffect, useState } from "react";
import type { CalendarEventView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { ApprovalCard } from "../Approval";
import { Markdown } from "../Markdown";
import { Composer, compose } from "../Shell";
import { addDays, AreaChip, clock, dayName, Empty, pressable, Sheet, shortDay, Stage, startOfDay } from "../ui";
import { CalendarNote, eventEnd, eventStart, useCalendar, weekStart, WeekGrid } from "./Week";

// --- Inbox: everything waiting on you ------------------------------------------------------

export function Inbox({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  const [tab, setTab] = useState<"all" | "approval" | "question" | "review" | "failed">("all");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    atlas.send({ type: "atlas.inbox" });
  }, [atlas.voice.connected]);
  // What needs a decision first, then the rest; oldest first, one open at a time (docs/ui §3). The scope switcher narrows it to one area.
  const all = s.inbox ?? [];
  const deciding = all.filter((i) => i.kind === "approval" || i.kind === "question");
  const items = [...deciding, ...all.filter((i) => !deciding.includes(i)).reverse()].filter(
    (i) => (tab === "all" || i.kind === tab) && (!s.scope || !i.areas.length || i.areas.includes(s.scope)),
  );
  const current = items.find((i) => i.id === open) ?? items[0];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Keys on a focused control are that control's, and shortcuts with a modifier are someone else's.
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, button, a, [role=button], [contenteditable]")) return;
      const i = items.findIndex((x) => x.id === current?.id);
      if (e.key === "j") setOpen(items[Math.min(items.length - 1, i + 1)]?.id ?? null);
      if (e.key === "k") setOpen(items[Math.max(0, i - 1)]?.id ?? null);
      // Enter marks finished work done; it never answers an approval or a question.
      if (e.key === "Enter" && current && (current.kind === "review" || current.kind === "failed")) {
        atlas.send({ type: "atlas.inbox.done", id: current.id });
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [items, current]);

  return (
    <Stage
      label="Inbox"
      tabs={[
        { id: "all", label: "All", badge: s.inbox?.length || null },
        { id: "approval", label: "Approvals", badge: s.inbox?.filter((i) => i.kind === "approval").length || null },
        { id: "question", label: "Questions", badge: s.inbox?.filter((i) => i.kind === "question").length || null },
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
            <Empty title="Nothing is waiting on you">
              What needs your OK, questions Atlas can't answer alone, finished background work and anything that didn't finish land here.
            </Empty>
          )}
          <div className="rows">
            {items.map((i) => {
              const on = i.id === current?.id;
              return (
                <div key={i.id} className="r" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  {/* Only the header opens the item, so the card's own buttons aren't inside a button. */}
                  <div
                    className="row"
                    style={{ flexWrap: "nowrap", cursor: "pointer" }}
                    aria-expanded={on}
                    {...pressable(() => setOpen(i.id))}
                  >
                    <span className={`tag ${i.kind === "failed" || i.kind === "approval" ? "ac" : ""}`}>
                      {i.kind === "failed"
                        ? "Didn't finish"
                        : i.kind === "approval"
                          ? i.approval?.hold
                            ? "Can't be undone"
                            : "Needs your OK"
                          : i.kind === "question"
                            ? "Question"
                            : "Ready for review"}
                    </span>
                    <span style={{ fontWeight: 500 }} className="grow">
                      {i.title}
                    </span>
                    <AreaChip ids={i.areas} areas={s.areas} />
                    <span className="mono faint small">{shortDay(i.at)}</span>
                  </div>
                  {on && i.approval && (
                    <div className="rise" onClick={(e) => e.stopPropagation()}>
                      <ApprovalCard atlas={atlas} a={i.approval} />
                    </div>
                  )}
                  {on && i.question && (
                    <div
                      className="rise"
                      style={{ display: "flex", flexDirection: "column", gap: 10 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <p>{i.text}</p>
                      <div className="row">
                        <button
                          className="btn primary"
                          onClick={() => atlas.send({ type: "atlas.trust.set", key: i.question!.key, trusted: true })}
                        >
                          {i.question.yes}
                        </button>
                        <button
                          className="btn"
                          onClick={() => atlas.send({ type: "atlas.trust.set", key: i.question!.key, trusted: false })}
                        >
                          {i.question.no}
                        </button>
                      </div>
                    </div>
                  )}
                  {on && !i.approval && !i.question && (
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
  kind: "Event" | "Reminder" | "Promise" | "Job" | "Automation";
  title: string;
  source: string;
  id: string;
  /** Where it was said: the owner's words, for reminders and promises (§13.4). */
  said?: { text: string; at: number };
  /** Can be cancelled from here. */
  cancel?: boolean;
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
      // Notifications held for quiet hours are the outbox's, and approvals wait in Inbox: neither is something on your clock.
      .filter(
        (a) =>
          (a.state === "scheduled" || a.state === "running") &&
          !["notify", "approval", "skills", "situation", "rhythm", "errand"].includes(a.kind),
      )
      .map((a): AgendaEntry => {
        const d = a.source.detail ?? {};
        return {
          at: new Date(a.due_at),
          allDay: false,
          kind: a.kind === "job" ? "Job" : a.kind === "promise" ? "Promise" : a.kind === "automation" ? "Automation" : "Reminder",
          title: a.title,
          source: a.kind === "job" ? "Helper" : a.kind === "automation" ? "Automations" : "Atlas",
          id: a.id,
          ...(typeof d.said === "string" ? { said: { text: d.said, at: typeof d.said_at === "number" ? d.said_at : a.created_at } } : {}),
          cancel: (a.kind === "reminder" || a.kind === "promise") && a.state === "scheduled",
        };
      }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const tasks = s.view?.tasks ?? [];
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
      meta={s.view?.calendar.provider ? `Calendar · ${s.view.calendar.provider.name}` : "Calendar not connected"}
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
              {tasks.length > 0 && !day && (
                <div>
                  <div className="section-rule">
                    <span className="lab">To do · {tasks.length}</span>
                  </div>
                  <div className="rows">
                    {tasks.map((t) => (
                      <div key={t.id} className="r" style={{ flexWrap: "wrap", rowGap: 4 }}>
                        <span className="tag ac" style={{ width: 84, flex: "none", justifyContent: "center" }}>
                          ◆ To do
                        </span>
                        <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                          {t.title}
                          <span className="faint small" style={{ display: "block", marginTop: 2 }}>
                            {t.fits ? `${t.fits.charAt(0).toUpperCase()}${t.fits.slice(1)}: Atlas brings it up when it fits` : "Whenever"}
                            {t.by ? ` · by ${shortDay(t.by)}` : ""}
                          </span>
                        </span>
                        <button className="link small" onClick={() => atlas.send({ type: "atlas.task.done", id: t.id, done: true })}>
                          Done
                        </button>
                        <button className="link small faint" onClick={() => atlas.send({ type: "atlas.task.done", id: t.id, done: false })}>
                          Drop
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!shown.length && !tasks.length && (
                <Empty title="Nothing on the clock">Events, reminders, what Atlas promised to do, and its background jobs show here.</Empty>
              )}
              {[...byDay].map(([d, list]) => (
                <div key={d}>
                  <div className="section-rule">
                    <span className="lab">{dayName(new Date(d))}</span>
                  </div>
                  <div className="rows">
                    {list.map((e) => {
                      const atlasOwn = e.kind === "Reminder" || e.kind === "Promise";
                      return (
                        <div key={`${e.kind}:${e.id}`} className="r" style={{ alignItems: "flex-start", flexWrap: "wrap", rowGap: 4 }}>
                          <span className="mono faint small" style={{ width: 70, flex: "none", paddingTop: 2 }}>
                            {e.allDay ? "All day" : clock(e.at)}
                          </span>
                          <span className={`tag ${atlasOwn ? "ac" : ""}`} style={{ width: 84, flex: "none", justifyContent: "center" }}>
                            {atlasOwn ? "◆ " : ""}
                            {e.kind}
                          </span>
                          <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                            {e.title}
                            {e.said && (
                              <span className="faint small" style={{ display: "block", marginTop: 2 }}>
                                You said, {shortDay(e.said.at)}: “{e.said.text}”
                              </span>
                            )}
                          </span>
                          <span className="faint small hide-phone">{e.source}</span>
                          {e.cancel && (
                            <button className="link small" onClick={() => atlas.send({ type: "atlas.agenda.cancel", id: e.id })}>
                              Cancel
                            </button>
                          )}
                        </div>
                      );
                    })}
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
