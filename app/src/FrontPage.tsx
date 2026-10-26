// The front page (M7 W15, docs/ui/source/wow-pass.html move 4): the first open of the day. Until the owner says
// something today, Home opens on Atlas's presence at full size: the living diamond, one useful line, then three real
// things (what's next on a map with its route and when to leave, the weather to scale, what needs you with hold to
// confirm), and what finished while the owner was away, as itself. Once they speak, the day's presence in the thread
// takes its place.

import { useEffect } from "react";
import type { LogRow } from "../../core/src/protocol";
import { sky, temp } from "../../core/src/weather";
import type { Atlas } from "./connection";
import { Files, filesOf } from "./JobViews";
import { MapCanvas } from "./SenseViews";
import { diamondState, type Opens } from "./Thread";
import { addDays, AsciiDiamond, clock, CountUp, HoldButton, Icon, morphOrigin, startOfDay, useNow } from "./ui";
import { eventEnd, eventStart, useCalendar } from "./pages/Week";

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Late night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

/** A span of time in words a glance can take: "7 h 28 min", "12 min". */
function span(ms: number): { h: number; m: number } {
  const m = Math.max(0, Math.round(ms / 60_000));
  return { h: Math.floor(m / 60), m: m % 60 };
}

export function FrontPage({ atlas, opens }: { atlas: Atlas; opens: Opens }) {
  const s = atlas.state;
  const now = useNow();
  const today = startOfDay(new Date(now));
  // The same feeds as Now: the situation (where you are, the trip to what's next) and the weather.
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.stage", ref: "situation", view: { kind: "situation" } });
    atlas.send({ type: "atlas.stage", ref: "weather", view: { kind: "weather" } });
  }, [atlas.voice.connected, s.situationVersion]);
  const sit = s.stage.situation?.kind === "situation" ? s.stage.situation : null;
  const wx = s.stage.weather?.kind === "weather" ? s.stage.weather : null;
  const cal = useCalendar(atlas, "front", today, addDays(today, 3));
  const events = (cal?.events ?? []).filter((e) => !e.all_day && eventEnd(e).getTime() > now);
  const next = events[0];
  const todays = events.filter((e) => eventStart(e) < addDays(today, 1));
  const travel = sit?.next?.travel && next && sit.next.title === next.title ? sit.next.travel : null;
  const inbox = (s.inbox ?? []).filter((i) => !s.answered[i.id]);
  const owner = s.view?.settings.owner_name?.split(" ")[0];
  const narrow = window.matchMedia("(max-width: 760px)").matches;

  // One useful line: what the day is like and the one thing that matters in it.
  const line = [
    !s.view?.calendar.provider
      ? "Connect a calendar and I'll keep an eye on your day."
      : todays.length === 0
        ? next
          ? `Nothing on the calendar today; next is ${next.title}, ${eventStart(next).toLocaleDateString([], { weekday: "long" })}.`
          : "Nothing on the calendar today."
        : todays.length === 1
          ? `One thing today: ${next!.title} at ${clock(eventStart(next!))}.`
          : `${todays.length} things today, starting with ${next!.title} at ${clock(eventStart(next!))}.`,
    travel ? `Leave by ${clock(travel.leave_by)}.` : "",
    inbox.length === 1 ? "One thing needs you." : inbox.length > 1 ? `${inbox.length} things need you.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // What finished while the owner was away: the newest result with something to look at, since they last spoke.
  const lastSaid = [...s.rows].reverse().find((r) => r.kind === "message.in" && r.actor === "owner")?.at ?? 0;
  const away: LogRow | undefined = [...s.rows]
    .reverse()
    .find((r) => r.kind === "job.result" && r.at > lastSaid && r.at > now - 36 * 3_600_000 && filesOf(r.body.files).length > 0);

  // The countdown: to when to leave, or to the start of what's next.
  const until = travel ? travel.leave_by : next ? eventStart(next).getTime() : null;
  const left = until != null ? span(until - now) : null;
  const hours = (wx?.weather?.hours ?? []).filter((h) => h.t > now - 3_600_000).slice(0, 18);
  const tMax = Math.max(...hours.map((h) => h.temp_c), 1);
  const tMin = Math.min(...hours.map((h) => h.temp_c), 0);
  const u = wx?.units ?? sit?.units ?? "metric";
  const ask = inbox.find((i) => i.kind === "approval") ?? inbox[0];

  return (
    <section className="front" aria-label="Today">
      <div className="front-top">
        <div className="front-mark">
          <AsciiDiamond height={narrow ? 120 : 196} level={atlas.inCall ? atlas.voice.level : 0} state={diamondState(atlas)} />
        </div>
        <div className="front-words">
          <span className="lab">
            {new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {clock(now)}
          </span>
          <h1 className="disp front-hello">
            {greeting(new Date(now))}
            {owner ? `, ${owner}` : ""}.
          </h1>
          <p className="front-line">{line}</p>
        </div>
      </div>

      <div className="front-tiles">
        <button
          className="front-tile next"
          onClick={(e) => {
            morphOrigin(e.currentTarget);
            opens.week();
          }}
        >
          <span className="lab">Next</span>
          {next ? (
            <>
              <span className="ft-title clip">{next.title}</span>
              <span className="ft-sub clip">
                {clock(eventStart(next))}
                {next.location ? ` · ${next.location.split("\n")[0]}` : ""}
                {travel ? ` · ${Math.max(1, Math.round(travel.s / 60))} min away` : ""}
              </span>
              {travel?.a && travel.b && (
                <div className="ft-map" onClick={(e) => e.stopPropagation()}>
                  <MapCanvas
                    markers={[
                      { name: "You", lat: travel.a.lat, lon: travel.a.lon, here: true },
                      { name: next.title, lat: travel.b.lat, lon: travel.b.lon },
                    ]}
                    line={travel.line}
                    height={132}
                  />
                </div>
              )}
            </>
          ) : (
            <span className="ft-title faint">{s.view?.calendar.provider ? "Nothing coming up" : "No calendar yet"}</span>
          )}
        </button>

        <div className="front-tile">
          <span className="lab">{travel ? "Leave in" : next ? "Starts in" : "Weather"}</span>
          {left && (left.h > 0 || left.m > 0) && (
            <span className="ft-count">
              {left.h > 0 && (
                <>
                  <CountUp value={left.h} /> <small>h</small>{" "}
                </>
              )}
              <CountUp value={left.m} /> <small>min</small>
            </span>
          )}
          {wx?.weather ? (
            <>
              <span className="ft-sub">
                {temp(wx.weather.now.temp_c, u)} and {sky(wx.weather.now.code)}
                {wx.matters.length ? `. ${wx.matters[0]}` : ""}
              </span>
              {hours.length >= 3 && (
                <div className="ft-hours" aria-hidden>
                  {hours.map((h, i) => (
                    <i
                      key={h.t}
                      className={h.pop >= 40 ? "rain" : ""}
                      style={
                        {
                          "--h": (0.25 + (0.75 * (h.temp_c - tMin)) / Math.max(1, tMax - tMin)).toFixed(2),
                          "--i": i,
                        } as React.CSSProperties
                      }
                      title={`${new Date(h.t).toLocaleTimeString([], { hour: "numeric" })}: ${temp(h.temp_c, u)}, ${h.pop}% rain`}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="ft-sub faint">{wx?.error ?? "Looking at the weather."}</span>
          )}
        </div>

        <div className={`front-tile ${ask ? "needs" : ""}`}>
          <span className="lab">
            Needs you
            {inbox.length > 0 && (
              <>
                {" "}
                · <CountUp value={inbox.length} />
              </>
            )}
          </span>
          {ask ? (
            <>
              <span className="ft-title clamp2">{ask.title}</span>
              {ask.text && <span className="ft-sub clamp2">{ask.text}</span>}
              {ask.kind === "approval" && ask.approval ? (
                <HoldButton onDone={() => atlas.send({ type: "atlas.approval.decide", id: ask.id, yes: true })}>Hold to OK</HoldButton>
              ) : (
                <button className="btn sm ft-open" onClick={opens.inbox}>
                  Open <Icon name="right" size={12} />
                </button>
              )}
            </>
          ) : (
            <span className="ft-title faint">Nothing waiting</span>
          )}
        </div>
      </div>

      {away && (
        <div className="front-away">
          <span className="lab">While you were away</span>
          <span className="fa-title">{String(away.body.title ?? "Something finished")}</span>
          <Files files={filesOf(away.body.files).slice(0, 2)} />
        </div>
      )}
      <p className="front-hint">Ask anything, tell me something to remember, or press Space to talk.</p>
    </section>
  );
}
