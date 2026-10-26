// A day at a glance (M7 W18, docs/ui/source/wow-pass.html move 1): when Atlas answers about a day, the day is
// drawn to scale under its words, in place of a list. Its events in their areas' colors, the trip to the next
// one and when to leave, the weather over it hour by hour, the free stretches, and now as an ember needle when
// it's today. Built from what the app already reads: the calendar, the situation and the weather.

import { useEffect } from "react";
import { sky, temp } from "../../core/src/weather";
import type { Atlas } from "./connection";
import { eventArea, eventEnd, eventStart, useCalendar } from "./pages/Week";
import { addDays, areaColor, clock, useNow } from "./ui";

const HOUR = 3_600_000;

/** "4 PM", "12 PM": an hour on the ruler. */
const hourMark = (h: number) => `${((h + 11) % 12) + 1}${h < 12 || h === 24 ? "A" : "P"}`;

export function DayStrip({ atlas, date, big = false }: { atlas: Atlas; date: string; big?: boolean }) {
  const s = atlas.state;
  const now = useNow();
  const day = new Date(`${date}T00:00`);
  const cal = useCalendar(atlas, `day:${date}`, day, addDays(day, 1));
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.stage", ref: "situation", view: { kind: "situation" } });
    atlas.send({ type: "atlas.stage", ref: "weather", view: { kind: "weather" } });
  }, [atlas.voice.connected, s.situationVersion]);
  const sit = s.stage.situation?.kind === "situation" ? s.stage.situation : null;
  const wx = s.stage.weather?.kind === "weather" ? s.stage.weather : null;
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  const all = (cal?.events ?? []).filter((e) => eventStart(e).getTime() < end && eventEnd(e).getTime() > start);
  const timed = all.filter((e) => !e.all_day).sort((a, b) => eventStart(a).getTime() - eventStart(b).getTime());
  const allDay = all.filter((e) => e.all_day);
  // The ruler covers the day's waking hours, wider when something falls outside them.
  const first = Math.min(8, ...timed.map((e) => Math.max(0, eventStart(e).getHours())));
  const last = Math.max(22, ...timed.map((e) => Math.min(24, Math.ceil((eventEnd(e).getTime() - start) / HOUR))));
  const from = start + first * HOUR;
  const span = (last - first) * HOUR;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - from) / span) * 100));
  // A deadline is a moment, not a stretch: a short event late in the day, or one named as due.
  const isMark = (e: (typeof timed)[number]) => eventEnd(e).getTime() - eventStart(e).getTime() <= 10 * 60_000 || /\bdue\b/i.test(e.title);
  const blocks = timed.filter((e) => !isMark(e));
  const marks = timed.filter(isMark);
  // The trip to what's next, when it's on this day.
  const travel =
    sit?.next?.travel && blocks.some((e) => e.title === sit.next!.title && eventStart(e).getTime() === sit.next!.start)
      ? { ...sit.next.travel, start: sit.next.start }
      : null;
  // Free stretches of two hours or more between what's on.
  const free: Array<{ a: number; b: number }> = [];
  let cursor = Math.max(from, start + first * HOUR);
  for (const e of blocks) {
    const a = eventStart(e).getTime();
    if (a - cursor >= 2 * HOUR) free.push({ a: cursor, b: a });
    cursor = Math.max(cursor, eventEnd(e).getTime());
  }
  if (from + span - cursor >= 2 * HOUR) free.push({ a: cursor, b: from + span });
  const u = wx?.units ?? sit?.units ?? "metric";
  const hours = (wx?.weather?.hours ?? []).filter((h) => h.t >= from && h.t < from + span);
  const weatherMarks = hours.filter((_, i) => i % 2 === 0);
  const ticks = Array.from({ length: Math.floor((last - first) / 2) + 1 }, (_, i) => first + i * 2).filter((h) => h <= last);
  const today = now >= start && now < end;
  const title = today ? "Today" : now >= start - 86_400_000 && now < start ? "Tomorrow" : day.toLocaleDateString([], { weekday: "long" });

  return (
    <div className={`day-strip ${big ? "big" : ""}`}>
      <div className="ds-head">
        <span className="ds-title disp">
          {title} <span className="ds-date">{day.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
        </span>
        <span className="grow" />
        {travel && travel.leave_by > now && <span className="ds-leave mono">Leave by {clock(travel.leave_by)}</span>}
      </div>
      {(allDay.length > 0 || marks.length > 0) && (
        <div className="ds-allday">
          {allDay.map((e) => (
            <span key={e.id} className="ds-chip" style={{ "--c": areaColor(eventArea(e, s.areas)) } as React.CSSProperties}>
              {e.title}
            </span>
          ))}
          {/* Deadlines by name up here, a tick at their time in the lane. */}
          {marks.map((e) => (
            <span key={e.id} className="ds-chip due" style={{ "--c": areaColor(eventArea(e, s.areas)) } as React.CSSProperties}>
              {e.title.replace(/\s*due\s*$/i, "")} · due {clock(eventStart(e))}
            </span>
          ))}
        </div>
      )}
      <div className="ds-track">
        {weatherMarks.length > 0 && (
          <div className="ds-wx" aria-hidden>
            {weatherMarks.map((h, i) => (
              <span key={h.t} className="ds-w" style={{ left: `${pct(h.t)}%`, "--i": i } as React.CSSProperties} title={sky(h.code)}>
                <i className={h.pop >= 40 ? "rain" : h.code >= 2 ? "cloud" : "sun"} />
                {temp(h.temp_c, u).replace(/[CF]$/, "")}
              </span>
            ))}
          </div>
        )}
        <div className="ds-lane">
          {free.map((f) => (
            <span key={f.a} className="ds-free mono" style={{ left: `${pct(f.a)}%`, width: `${pct(f.b) - pct(f.a)}%` }}>
              {Math.round((f.b - f.a) / HOUR)} h free
            </span>
          ))}
          {travel && (
            <span
              className="ds-leg"
              style={{
                left: `${pct(travel.start - travel.s * 1000)}%`,
                width: `${pct(travel.start) - pct(travel.start - travel.s * 1000)}%`,
              }}
            >
              <i className="mono">{Math.max(1, Math.round(travel.s / 60))} min</i>
            </span>
          )}
          {blocks.map((e, i) => (
            <span key={e.id} title={`${e.title}, ${clock(eventStart(e))} to ${clock(eventEnd(e))}`}>
              <span
                className="ds-ev"
                style={
                  {
                    left: `${pct(eventStart(e).getTime())}%`,
                    width: `${Math.max(1, pct(eventEnd(e).getTime()) - pct(eventStart(e).getTime()))}%`,
                    "--c": areaColor(eventArea(e, s.areas)),
                    "--i": i,
                  } as React.CSSProperties
                }
              />
              {/* Its name under it, on alternating rows, so names of events close together don't run into each other. */}
              <span
                className={`ds-ev-label ${i % 2 ? "low" : ""}`}
                style={
                  { left: `${pct(eventStart(e).getTime())}%`, "--c": areaColor(eventArea(e, s.areas)), "--i": i } as React.CSSProperties
                }
              >
                <span className="ds-ev-t">{e.title}</span>
                <span className="ds-ev-s mono">{clock(eventStart(e))}</span>
              </span>
            </span>
          ))}
          {marks.map((e) => (
            <span
              key={e.id}
              className="ds-mark"
              style={{ left: `${pct(eventStart(e).getTime())}%`, "--c": areaColor(eventArea(e, s.areas)) } as React.CSSProperties}
              title={`${e.title}, ${clock(eventStart(e))}`}
            />
          ))}
          {today && now > from && now < from + span && <span className="ds-now" style={{ left: `${pct(now)}%` }} />}
        </div>
        <div className="ds-ruler mono" aria-hidden>
          {ticks.map((h) => (
            <span key={h} style={{ left: `${pct(start + h * HOUR)}%` }}>
              {hourMark(h)}
            </span>
          ))}
        </div>
      </div>
      {!cal && <p className="faint small">Reading the calendar.</p>}
      {cal?.error && <p className="faint small">{cal.error}</p>}
      {cal && !cal.error && timed.length === 0 && allDay.length === 0 && <p className="ds-clear">Nothing on the calendar.</p>}
    </div>
  );
}
