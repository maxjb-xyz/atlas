// Views drawn in the message itself (M7 W18, docs/ui/source/wow-pass.html move 1): a route on its map, the weather
// over the next hours, options side by side, a picture or a video, and an answer's sources. The thread is the stage
// until the owner taps to enlarge. Each is built from the view Atlas showed, or from what the app already reads.
// Under a view, the next steps Atlas offered: each a tap that asks it to do that.

import { useEffect, useState } from "react";
import type { StageView } from "../../core/src/stage";
import { distance, sky, temp, type Units } from "../../core/src/weather";
import type { Atlas } from "./connection";
import { MapCanvas } from "./SenseViews";
import { hostOf, Icon, type IconName, SiteMark } from "./ui";

type Of<K extends StageView["kind"]> = Extract<StageView, { kind: K }>;

const BY: Record<string, string> = { drive: "drive", walk: "walk", bike: "ride" };

/** A route on its map, or saved places marked on one. */
export function InlineMap({ v, units }: { v: Of<"map">; units: Units }) {
  const markers = v.markers ?? [];
  const from = markers[0]?.name;
  const to = markers[markers.length - 1]?.name;
  return (
    <span className="iv iv-map">
      <span className="iv-head">
        {v.route ? (
          <>
            <span className="iv-big disp">{Math.max(1, Math.round(v.route.s / 60))} min</span>
            <span className="iv-sub">
              {BY[v.route.by] ?? v.route.by} · {distance(v.route.m, v.route.units ?? units)}
              {v.route.traffic ? " · with traffic" : ""}
            </span>
            <span className="grow" />
            {from && to && (
              <span className="iv-sub clip">
                {from} <Icon name="right" size={11} /> {to}
              </span>
            )}
          </>
        ) : (
          <span className="iv-sub clip">{markers.map((m) => m.name).join(" · ") || v.title}</span>
        )}
      </span>
      {markers.length > 0 && (
        <span className="iv-canvas" onClick={(e) => e.stopPropagation()}>
          <MapCanvas markers={markers} line={v.route?.line} height={200} />
        </span>
      )}
    </span>
  );
}

/** The weather near the owner: now, and the next twelve hours to scale. */
export function InlineWeather({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.stage", ref: "weather", view: { kind: "weather" } });
  }, [atlas.voice.connected, s.situationVersion]);
  const wx = s.stage.weather?.kind === "weather" ? s.stage.weather : null;
  if (!wx?.weather) return <span className="iv iv-wx faint small">{wx?.error ?? "Looking at the weather."}</span>;
  const u = wx.units;
  const hours = wx.weather.hours.filter((h) => h.t > Date.now() - 3_600_000).slice(0, 12);
  const hi = Math.max(...hours.map((h) => h.temp_c));
  const lo = Math.min(...hours.map((h) => h.temp_c));
  return (
    <span className="iv iv-wx">
      <span className="iv-head">
        <span className="iv-big disp">{temp(wx.weather.now.temp_c, u)}</span>
        <span className="iv-sub">
          {sky(wx.weather.now.code)}, feels like {temp(wx.weather.now.feels_c, u)}
        </span>
      </span>
      {wx.matters.length > 0 && <span className="iv-line">{wx.matters[0]}</span>}
      <span className="iv-hours" aria-hidden>
        {hours.map((h, i) => (
          <span key={h.t} className="iv-hour" style={{ "--i": i } as React.CSSProperties}>
            <span className="mono">{temp(h.temp_c, u).replace(/[CF]$/, "")}</span>
            <i
              className={h.pop >= 40 ? "rain" : ""}
              style={{ height: `${Math.round(14 + (34 * (h.temp_c - lo)) / Math.max(1, hi - lo))}px` }}
            />
            <span className="mono faint">{new Date(h.t).toLocaleTimeString([], { hour: "numeric" }).replace(/\s?([AP])M/, "$1")}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Options side by side on what matters, the pick marked, and why. */
export function InlineCompare({ v }: { v: Of<"compare"> }) {
  const pick = v.options.findIndex((o) => o.name === v.pick);
  return (
    <span className="iv iv-compare">
      <span className="iv-grid" style={{ gridTemplateColumns: `minmax(80px, auto) repeat(${v.options.length}, minmax(0, 1fr))` }}>
        <span />
        {v.options.map((o, i) => (
          <span key={o.name} className={`iv-opt ${i === pick ? "pick" : ""}`}>
            {o.name}
            {i === pick && <span className="lab">Pick</span>}
          </span>
        ))}
        {v.rows.slice(0, 6).map((r) => (
          <span key={r.label} className="iv-row">
            <span className="lab">{r.label}</span>
            {v.options.map((o, i) => (
              <span key={o.name} className={i === pick ? "pick" : ""}>
                {r.values[i] == null ? "–" : String(r.values[i])}
              </span>
            ))}
          </span>
        ))}
      </span>
      {v.why && <span className="iv-line">{v.why}</span>}
    </span>
  );
}

/** A picture or a video Atlas made, as itself. */
export function InlineMedia({ file }: { file: { id: string; name: string; type: string } }) {
  const src = `/api/files/${file.id}?inline=1`;
  return (
    <span className="iv iv-media">
      {file.type.startsWith("image/") ? (
        <img src={src} alt={file.name} loading="lazy" />
      ) : (
        <video src={`${src}#t=0.5`} controls preload="metadata" onClick={(e) => e.stopPropagation()} />
      )}
      <span className="iv-sub clip">{file.name}</span>
    </span>
  );
}

/** An answer from the web: its sources, numbered as the answer cites them, each with its site's icon. */
export function InlineResearch({ v }: { v: Of<"research"> }) {
  return (
    <span className="iv iv-research">
      <span className="iv-sub">{v.title}</span>
      <span className="iv-sources">
        {v.sources.slice(0, 5).map((x, i) => (
          <a key={x.url} href={x.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="iv-source">
            <span className="mono faint">{i + 1}</span>
            <SiteMark host={hostOf(x.url)} size={16} />
            <span className="clip">{x.title}</span>
            <span className="faint clip">{hostOf(x.url)}</span>
          </a>
        ))}
        {v.sources.length > 5 && <span className="faint small">and {v.sources.length - 5} more</span>}
      </span>
    </span>
  );
}

/** The icon for a next step, by its first word. */
function nextIcon(text: string): IconName {
  const t = text.toLowerCase();
  if (/^(remind|tell me|ping)/.test(t)) return "bell";
  if (/^(block|add|schedule|book|move|hold)/.test(t)) return "plus";
  if (/^(route|directions|leave|take me|get me)/.test(t)) return "place";
  if (/^(send|email|mail|reply|text)/.test(t)) return "send";
  if (/^(save|keep|make|write|draft)/.test(t)) return "file";
  if (/^(find|look|search|check|compare)/.test(t)) return "search";
  return "right";
}

/** The next steps Atlas offered under a view: a tap asks it to do one, once. */
export function NextSteps({ atlas, next }: { atlas: Atlas; next: string[] }) {
  const [asked, setAsked] = useState<string | null>(null);
  return (
    <span className="next-steps">
      {next.map((n, i) => (
        <button
          key={n}
          className={`next-step ${asked === n ? "on" : ""}`}
          disabled={asked != null}
          style={{ "--i": i } as React.CSSProperties}
          onClick={() => {
            setAsked(n);
            atlas.say(n);
          }}
        >
          <Icon name={nextIcon(n)} size={13} />
          {n}
        </button>
      ))}
    </span>
  );
}
