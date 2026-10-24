// The week (§21.6 "week"): the calendar as a grid, with reminders and jobs
// as small outlined markers. Used on Home's Week tab and Agenda's Week.

import { useEffect } from "react";
import type { AgendaItem, CalendarEventView } from "../../../core/src/protocol";
import type { Atlas, CalendarState } from "../connection";
import { addDays, clock, localDate, startOfDay } from "../ui";

const FIRST_HOUR = 7;
const LAST_HOUR = 22;
const HOUR_PX = 34;

/** Monday of the week that holds `d`. */
export function weekStart(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

/** Asks for the calendar in a range under `ref`, again whenever the calendar might have changed. */
export function useCalendar(atlas: Atlas, ref: string, start: Date, end: Date): CalendarState | undefined {
  const connected = Boolean(atlas.state.view?.calendar.provider);
  const key = `${localDate(start)}|${localDate(end)}`;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.calendar", ref, start: localDate(start), end: localDate(end) });
  }, [key, connected, atlas.voice.connected]);
  return atlas.state.calendar[ref];
}

/** Under a calendar: why it couldn't be read, or that it's Atlas's copy from earlier because iCloud couldn't be asked. */
export function CalendarNote({ atlas, cal }: { atlas: Atlas; cal: CalendarState | undefined }) {
  if (cal?.error) {
    return (
      <p className={`small ${atlas.state.view?.calendar.provider ? "err" : "muted"}`} style={{ marginBottom: 10 }}>
        {cal.error}
      </p>
    );
  }
  if (!cal?.stale) return null;
  return (
    <p className="small muted" style={{ marginBottom: 10 }} title={cal.stale.why}>
      Showing Atlas's copy from {clock(new Date(cal.stale.as_of))}; iCloud can't be asked right now. Abilities → Services says why.
    </p>
  );
}

export const eventStart = (e: CalendarEventView) => (e.all_day ? new Date(`${e.start}T00:00`) : new Date(e.start));
export const eventEnd = (e: CalendarEventView) => (e.all_day ? new Date(`${e.end}T00:00`) : new Date(e.end));

export function WeekGrid({ events, agenda, start }: { events: CalendarEventView[]; agenda: AgendaItem[]; start: Date }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = localDate(new Date());
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
  const calendars = [...new Set(events.map((e) => e.calendar))];
  const color = (cal: string) => `var(--a${(calendars.indexOf(cal) + 2) % 8})`;
  const now = new Date();
  const nowTop = (now.getHours() + now.getMinutes() / 60 - FIRST_HOUR) * HOUR_PX;

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 640 }}>
        {calendars.length > 0 && (
          <div className="row" style={{ justifyContent: "flex-end", gap: 14, marginBottom: 10 }}>
            {calendars.map((c) => (
              <span key={c} className="chip">
                <span className="dot" style={{ background: color(c) }} />
                {c}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: `40px repeat(7, 1fr)`, borderBottom: "1px solid var(--sep)" }}>
          <span />
          {days.map((d) => {
            const isToday = localDate(d) === today;
            return (
              <div
                key={d.toISOString()}
                style={{ padding: "6px 8px", fontSize: 12.5, color: isToday ? "var(--ac)" : "var(--tx2)", fontWeight: isToday ? 600 : 400 }}
              >
                {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
              </div>
            );
          })}
        </div>
        {/* All-day events sit above the hours. */}
        <div style={{ display: "grid", gridTemplateColumns: `40px repeat(7, 1fr)`, gap: 0, minHeight: 6 }}>
          <span />
          {days.map((d) => (
            <div key={d.toISOString()} style={{ padding: "3px 3px 0", display: "flex", flexDirection: "column", gap: 2 }}>
              {events
                .filter((e) => e.all_day && eventStart(e) <= d && eventEnd(e) > d)
                .map((e) => (
                  <span
                    key={e.id}
                    className="small"
                    style={{
                      padding: "1px 6px",
                      borderLeft: `2px solid ${color(e.calendar)}`,
                      background: "var(--bg)",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.title}
                  </span>
                ))}
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `40px repeat(7, 1fr)`, position: "relative" }}>
          <div>
            {hours.map((h) => (
              <div key={h} className="lab" style={{ height: HOUR_PX, fontSize: 9.5, paddingTop: 2 }}>
                {h % 12 || 12}
                {h < 12 ? "a" : "p"}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const isToday = localDate(d) === today;
            const dayEnd = addDays(d, 1);
            const timed = events.filter((e) => !e.all_day && eventStart(e) < dayEnd && eventEnd(e) > d);
            // Reminders and promises: the things on the clock that are Atlas's to say or do.
            const marks = agenda.filter(
              (a) =>
                (a.kind === "reminder" || a.kind === "promise") &&
                a.state === "scheduled" &&
                new Date(a.due_at) >= d &&
                new Date(a.due_at) < dayEnd,
            );
            return (
              <div
                key={d.toISOString()}
                style={{
                  position: "relative",
                  height: hours.length * HOUR_PX,
                  borderLeft: "1px solid var(--sep)",
                  background: isToday ? "var(--acs)" : undefined,
                  backgroundImage: "linear-gradient(var(--sep) 1px, transparent 1px)",
                  backgroundSize: `100% ${HOUR_PX}px`,
                }}
              >
                {timed.map((e) => {
                  const s = Math.max(eventStart(e).getTime(), d.getTime());
                  const en = Math.min(eventEnd(e).getTime(), dayEnd.getTime());
                  const top = ((s - d.getTime()) / 3_600_000 - FIRST_HOUR) * HOUR_PX;
                  const height = Math.max(18, ((en - s) / 3_600_000) * HOUR_PX - 2);
                  if (top + height < 0 || top > hours.length * HOUR_PX) return null;
                  return (
                    <div
                      key={e.id}
                      className="rise"
                      title={`${e.title}${e.location ? ` · ${e.location}` : ""}`}
                      style={{
                        position: "absolute",
                        left: 3,
                        right: 3,
                        top: Math.max(0, top),
                        height,
                        border: "1px solid var(--sep2)",
                        borderLeft: `2px solid ${color(e.calendar)}`,
                        background: "var(--win)",
                        borderRadius: 4,
                        padding: "2px 6px",
                        fontSize: 11.5,
                        overflow: "hidden",
                      }}
                    >
                      <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</div>
                      <div className="faint">{clock(eventStart(e))}</div>
                    </div>
                  );
                })}
                {marks.map((a) => {
                  const t = new Date(a.due_at);
                  const top = (t.getHours() + t.getMinutes() / 60 - FIRST_HOUR) * HOUR_PX;
                  return (
                    <div
                      key={a.id}
                      title={`${a.title} · ${clock(t)}`}
                      style={{
                        position: "absolute",
                        left: 3,
                        right: 3,
                        top: Math.min(Math.max(0, top), hours.length * HOUR_PX - 16),
                        height: 16,
                        border: "1px dashed var(--ac)",
                        borderRadius: 3,
                        fontSize: 10.5,
                        padding: "0 5px",
                        color: "var(--ac)",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        background: "var(--win)",
                      }}
                    >
                      ◆ {a.title}
                    </div>
                  );
                })}
                {isToday && nowTop > 0 && nowTop < hours.length * HOUR_PX && (
                  <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: nowTop, borderTop: "1px solid var(--ac)" }}>
                    <span style={{ position: "absolute", left: -3, top: -3, width: 5, height: 5, background: "var(--ac)" }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
