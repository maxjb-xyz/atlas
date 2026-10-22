// M4's stage views (§21.6): the map, a place, the weather and the
// situation, drawn from their contracts (core/src/stage.ts). The map is
// MapLibre with OpenFreeMap's free tiles, loaded only when a map is shown,
// in the theme's light or dark style, with OpenStreetMap's credit on it.

import { useEffect, useRef, useState } from "react";
import type { PlacePage, SituationPage, StageView, WeatherPage } from "../../core/src/stage";
import { distance, sky, temp } from "../../core/src/weather";
import { clock, dayName, Icon, shortDay, useNow } from "./ui";

type Marker = { name: string; lat: number; lon: number; here?: boolean };

const STYLE = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/positron" };

const mins = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
const since = (at: number, now: number) => (now - at < 60_000 ? "just now" : `${mins((now - at) / 1000)} ago`);

/** A map with markers and a route line. MapLibre loads the first time one is shown. */
export function MapCanvas({ markers, line, height = 360 }: { markers: Marker[]; line?: Array<[number, number]>; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([markers, line?.length]);
  useEffect(() => {
    let map: { remove(): void } | null = null;
    let gone = false;
    (async () => {
      try {
        const [ml, worker] = await Promise.all([
          import("maplibre-gl"),
          import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
          import("maplibre-gl/dist/maplibre-gl.css"),
        ]);
        if (gone || !box.current) return;
        ml.setWorkerUrl(worker.default);
        const dark = document.documentElement.dataset.theme !== "daylight";
        const pts: Array<[number, number]> = [...markers.map((m) => [m.lon, m.lat] as [number, number]), ...(line ?? [])];
        const m = new ml.Map({
          container: box.current,
          style: dark ? STYLE.dark : STYLE.light,
          center: pts[0] ?? [0, 0],
          zoom: 14,
          attributionControl: { compact: true },
        });
        map = m;
        if (pts.length > 1) {
          const b = new ml.LngLatBounds(pts[0], pts[0]);
          for (const p of pts) b.extend(p);
          m.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
        }
        for (const mk of markers) {
          const el = document.createElement("div");
          el.className = `map-pin ${mk.here ? "here" : ""}`;
          el.title = mk.name;
          new ml.Marker({ element: el }).setLngLat([mk.lon, mk.lat]).addTo(m);
        }
        if (line?.length) {
          const accent = getComputedStyle(document.documentElement).getPropertyValue("--ac").trim() || "#ff6a3d";
          m.on("load", () => {
            m.addSource("route", {
              type: "geojson",
              data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } },
            });
            m.addLayer({
              id: "route",
              type: "line",
              source: "route",
              paint: { "line-color": accent, "line-width": 4, "line-opacity": 0.9 },
            });
          });
        }
      } catch (err) {
        if (!gone) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      gone = true;
      map?.remove();
    };
  }, [key]);
  if (error) return <p className="muted small">The map couldn't load: {error}</p>;
  return <div ref={box} className="map-canvas" style={{ height }} />;
}

function Title({
  icon,
  text,
  onClose,
  extra,
}: {
  icon: "place" | "layers" | "grid";
  text: string;
  onClose?: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="sheet-title">
      <Icon name={icon} />
      <h1 className="disp">{text}</h1>
      {extra}
      <span className="grow" />
      {onClose && (
        <button className="icon view-close" onClick={onClose} aria-label="Close this view" title="Close">
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

export function MapView({ view, onClose }: { view: Extract<StageView, { kind: "map" }>; onClose?: () => void }) {
  const r = view.route;
  return (
    <>
      <Title icon="place" text={view.title} onClose={onClose} />
      {r && (
        <p className="muted" style={{ marginBottom: 12 }}>
          {mins(r.s)} {r.by === "drive" ? "by car" : r.by === "walk" ? "on foot" : "by bike"}
          {r.traffic ? ", with traffic" : ", a typical time (no live traffic)"} · {Math.round(r.m / 100) / 10} km
        </p>
      )}
      <MapCanvas markers={view.markers ?? []} {...(r ? { line: r.line } : {})} />
      <ul className="map-legend small muted">
        {(view.markers ?? []).map((m) => (
          <li key={`${m.name}${m.lat}`}>
            <span className={`map-pin small ${m.here ? "here" : ""}`} /> {m.name}
          </li>
        ))}
      </ul>
    </>
  );
}

export function PlaceView({ page, onClose }: { page: PlacePage; onClose?: () => void }) {
  const p = page.place;
  const address = typeof p.details.address === "string" ? p.details.address : null;
  const stays = page.visits.filter((v) => v.stayed_ms != null).map((v) => v.stayed_ms!);
  const typical = stays.length ? stays.sort((a, b) => a - b)[Math.floor(stays.length / 2)]! : null;
  return (
    <>
      <Title icon="place" text={p.name} onClose={onClose} extra={page.here ? <span className="tag ok">You're here</span> : null} />
      {p.fact && <p style={{ marginBottom: 12, fontSize: 15 }}>{p.fact}</p>}
      {address && (
        <p className="muted" style={{ marginBottom: 12 }}>
          {address}
        </p>
      )}
      {page.pin ? (
        <MapCanvas markers={[{ name: p.name, lat: page.pin.lat, lon: page.pin.lon }]} height={280} />
      ) : (
        <p className="muted small">
          Not pinned on the map yet. Say "pin {p.name}" with its address, or "this is {p.name}" while you're there.
        </p>
      )}
      <div className="section-rule">
        <span className="lab">
          Visits{page.visits.length ? ` · ${page.visits.length}` : ""}
          {typical ? ` · usually ${mins(typical / 1000)}` : ""}
        </span>
      </div>
      {page.visits.length ? (
        <ul className="rows">
          {page.visits.slice(0, 12).map((v) => (
            <li key={v.at} className="r">
              <span>{shortDay(v.at)}</span>
              <span className="muted">{clock(v.at)}</span>
              <span className="grow" />
              <span className="mono faint small">{v.stayed_ms != null ? mins(v.stayed_ms / 1000) : "there now"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No visits yet. Arrivals show here once OwnTracks reports them.</p>
      )}
    </>
  );
}

export function WeatherView({ page, onClose }: { page: WeatherPage; onClose?: () => void }) {
  const w = page.weather;
  const u = page.units;
  return (
    <>
      <Title
        icon="layers"
        text="Weather"
        onClose={onClose}
        extra={w ? <span className="mono faint small">Open-Meteo · {clock(w.at)}</span> : null}
      />
      {!w ? (
        <p className="muted">{page.error}</p>
      ) : (
        <>
          <div className="row" style={{ gap: 16, alignItems: "baseline", marginBottom: 8 }}>
            <span className="disp" style={{ fontSize: 40 }}>
              {temp(w.now.temp_c, u)}
            </span>
            <span className="muted" style={{ fontSize: 15 }}>
              {sky(w.now.code)}, feels like {temp(w.now.feels_c, u)}
            </span>
          </div>
          {page.matters.length > 0 && (
            <p className="ac-text" style={{ marginBottom: 12 }}>
              {page.matters.join(" · ")}
            </p>
          )}
          <div className="weather-hours">
            {w.hours.map((h) => (
              <div key={h.t} className="weather-hour">
                <span className="faint small">{new Date(h.t).toLocaleTimeString([], { hour: "numeric" })}</span>
                <span>{temp(h.temp_c, u)}</span>
                <span
                  className="weather-rain"
                  style={{ height: `${h.pop >= 10 ? Math.max(3, h.pop * 0.4) : 0}px` }}
                  title={`${h.pop}% chance of rain`}
                />
                <span className="faint small">{h.pop >= 10 ? `${h.pop}%` : ""}</span>
              </div>
            ))}
          </div>
          <div className="section-rule">
            <span className="lab">The week</span>
          </div>
          <ul className="rows">
            {w.days.map((d) => (
              <li key={d.date} className="r">
                <span style={{ minWidth: 96 }}>{dayName(new Date(`${d.date}T12:00:00`))}</span>
                <span className="muted">{sky(d.code)}</span>
                <span className="grow" />
                {d.pop >= 20 && <span className="faint small">{d.pop}% rain</span>}
                <span className="mono small">
                  {temp(d.min_c, u)} to {temp(d.max_c, u)}
                </span>
              </li>
            ))}
          </ul>
          <p className="faint small" style={{ marginTop: 12 }}>
            For a rough area around you (about 10 km), never your exact spot.
          </p>
        </>
      )}
    </>
  );
}

/** Where the owner is, in words, from the situation. */
export function whereLine(p: SituationPage, now: number): string {
  const w = p.where;
  if (!w.known) return w.why;
  if (w.place) return `At ${w.place.name} since ${clock(w.place.since)}.`;
  const parts = [
    w.away?.home_m != null ? `${distance(w.away.home_m, p.units)} from home` : "",
    w.away?.left ? `left ${w.away.left.name} at ${clock(w.away.left.at)}` : "",
    w.motion ?? "",
  ].filter(Boolean);
  const old = now - w.fix_at > 3 * 3_600_000 ? ` (as of ${since(w.fix_at, now)})` : "";
  return `Out${parts.length ? `: ${parts.join(", ")}` : ""}${old}.`;
}

export function SituationView({ page: p, onClose }: { page: SituationPage; onClose?: () => void }) {
  const now = useNow();
  const markers: Marker[] = p.where.known ? [{ name: "You", lat: p.where.point.lat, lon: p.where.point.lon, here: true }] : [];
  return (
    <>
      <Title icon="place" text="Situation" onClose={onClose} />
      <div className="cells">
        <div className="cell">
          <span className="lab">Where</span>
          <p style={{ fontWeight: 500, fontSize: 15 }}>{whereLine(p, now)}</p>
          {p.where.known && <p className="faint small">Last report {since(p.where.fix_at, now)}</p>}
        </div>
        <div className="cell">
          <span className="lab">Doing</span>
          <p style={{ fontSize: 15 }}>
            {p.doing
              ? `${p.doing.title}, until ${clock(p.doing.until)}`
              : p.focus
                ? `Focusing${p.focus.about ? ` on ${p.focus.about}` : ""}`
                : "Nothing on the calendar right now."}
          </p>
        </div>
        <div className="cell">
          <span className={`lab ${p.next?.travel ? "ac" : ""}`}>Next</span>
          {p.next ? (
            <>
              <p style={{ fontWeight: 500, fontSize: 15 }}>
                {p.next.title}, {clock(p.next.start)}
              </p>
              {p.next.location && <p className="muted small">{p.next.location}</p>}
              {p.next.travel && (
                <p className="small" style={{ marginTop: 6 }}>
                  Leave by <b>{clock(p.next.travel.leave_by)}</b> · {mins(p.next.travel.s)} by car
                  {p.next.travel.traffic ? " with traffic" : ", typical"}
                </p>
              )}
              {p.next.travel_error && <p className="faint small">{p.next.travel_error}</p>}
            </>
          ) : (
            <p className="muted">{p.calendar_error ?? "Nothing more today."}</p>
          )}
        </div>
      </div>
      {p.weather && (
        <p className="small" style={{ marginTop: 12 }}>
          <span className="lab">Weather</span> {p.weather.line}
        </p>
      )}
      {p.devices.length > 0 && (
        <p className="small" style={{ marginTop: 8 }}>
          <span className="lab">Devices</span>{" "}
          {p.devices.map((d) => `${d.name}: ${d.online ? d.state || "online" : "offline"}`).join(" · ")}
        </p>
      )}
      {p.errands.length > 0 && (
        <p className="small" style={{ marginTop: 8 }}>
          <span className="lab">Errands</span> {p.errands.map((e) => e.title).join(" · ")}
        </p>
      )}
      {markers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <MapCanvas markers={markers} height={260} />
        </div>
      )}
    </>
  );
}
