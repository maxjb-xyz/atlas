// Weather (VISION §10.1, §10.2): Open-Meteo, which needs no key and is free
// for non-commercial use. It only ever gets a rough area (coordinates
// rounded to a tenth of a degree, about 10 km), never where you are (§4.4).
// Values are kept metric and said in the owner's units.

import type { LookOut } from "./web";
import { USER_AGENT } from "./maps";
import { clockLocal, zonedParts } from "./time";

export interface Hour {
  t: number;
  temp_c: number;
  /** Chance of rain, percent. */
  pop: number;
  precip_mm: number;
  code: number;
  wind_kmh: number;
}

export interface Day {
  /** Local date, YYYY-MM-DD. */
  date: string;
  max_c: number;
  min_c: number;
  pop: number;
  code: number;
  uv: number;
}

export interface Weather {
  /** When it was fetched. */
  at: number;
  area: { lat: number; lon: number };
  now: { temp_c: number; feels_c: number; code: number; wind_kmh: number };
  /** The next 24 hours. */
  hours: Hour[];
  /** Today and the next six days. */
  days: Day[];
}

/** A rough area around a point: a tenth of a degree, about 10 km. */
export const roughArea = (p: { lat: number; lon: number }) => ({ lat: Math.round(p.lat * 10) / 10, lon: Math.round(p.lon * 10) / 10 });

export async function fetchWeather(f: typeof fetch, area: { lat: number; lon: number }): Promise<LookOut<Weather>> {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(area.lat));
  u.searchParams.set("longitude", String(area.lon));
  u.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m");
  u.searchParams.set("hourly", "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m");
  u.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", "7");
  u.searchParams.set("timeformat", "unixtime");
  let res: Response;
  try {
    res = await f(u.toString(), { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `Couldn't reach Open-Meteo (api.open-meteo.com): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Said below with the status.
  }
  if (!res.ok || body.error) {
    const why = typeof body.reason === "string" ? body.reason : text.slice(0, 200);
    return { ok: false, status: res.status, error: `Open-Meteo (api.open-meteo.com) answered ${res.status}${why ? `: ${why}` : ""}` };
  }
  const cur = (body.current ?? {}) as Record<string, number>;
  const h = (body.hourly ?? {}) as Record<string, number[]>;
  const d = (body.daily ?? {}) as Record<string, number[] | string[]>;
  const now = Date.now();
  const hours: Hour[] = (h.time ?? [])
    .map((t, i) => ({
      t: t * 1000,
      temp_c: h.temperature_2m?.[i] ?? NaN,
      pop: h.precipitation_probability?.[i] ?? 0,
      precip_mm: h.precipitation?.[i] ?? 0,
      code: h.weather_code?.[i] ?? 0,
      wind_kmh: h.wind_speed_10m?.[i] ?? 0,
    }))
    .filter((x) => x.t > now - 3_600_000)
    .slice(0, 24);
  const days: Day[] = ((d.time ?? []) as number[]).map((t, i) => ({
    date: new Date(t * 1000 + Number(body.utc_offset_seconds ?? 0) * 1000).toISOString().slice(0, 10),
    max_c: (d.temperature_2m_max as number[] | undefined)?.[i] ?? NaN,
    min_c: (d.temperature_2m_min as number[] | undefined)?.[i] ?? NaN,
    pop: (d.precipitation_probability_max as number[] | undefined)?.[i] ?? 0,
    code: (d.weather_code as number[] | undefined)?.[i] ?? 0,
    uv: (d.uv_index_max as number[] | undefined)?.[i] ?? 0,
  }));
  if (!hours.length || cur.temperature_2m == null)
    return { ok: false, status: res.status, error: "Open-Meteo answered without a forecast." };
  return {
    ok: true,
    status: res.status,
    value: {
      at: now,
      area,
      now: {
        temp_c: cur.temperature_2m,
        feels_c: cur.apparent_temperature ?? cur.temperature_2m,
        code: cur.weather_code ?? 0,
        wind_kmh: cur.wind_speed_10m ?? 0,
      },
      hours,
      days,
    },
  };
}

/** WMO weather codes, in words. */
export function sky(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "foggy";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return code === 61 || code === 80 ? "light rain" : "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunderstorms";
  return "mixed";
}

export type Units = "us" | "metric";

export const temp = (c: number, u: Units) => `${Math.round(u === "us" ? (c * 9) / 5 + 32 : c)}°${u === "us" ? "F" : "C"}`;
export const speed = (kmh: number, u: Units) => (u === "us" ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`);
export const distance = (m: number, u: Units) =>
  u === "us"
    ? m < 300
      ? `${Math.round(m * 3.281)} ft`
      : `${(m / 1609).toFixed(m < 16_000 ? 1 : 0)} mi`
    : m < 1000
      ? `${Math.round(m)} m`
      : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

/** US time zones, for "auto" units. */
const US_ZONES =
  /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Adak|Indiana\/|Kentucky\/|North_Dakota\/|Menominee|Nome|Sitka|Yakutat|Metlakatla)|Pacific\/Honolulu|US\/)/;

export const unitsFor = (setting: "auto" | Units, tz: string): Units =>
  setting !== "auto" ? setting : US_ZONES.test(tz) ? "us" : "metric";

/**
 * What matters about the weather for the rest of today, in a few words each:
 * rain or storms likely (and when), real heat or cold, strong wind, high UV.
 * Empty when nothing does, so the situation and Now leave weather out.
 */
export function whatMatters(w: Weather, tz: string, u: Units, now = Date.now()): string[] {
  const out: string[] = [];
  const today = zonedParts(new Date(now), tz);
  const rest = w.hours.filter((h) => h.t >= now - 1_800_000 && zonedParts(new Date(h.t), tz).day === today.day);
  const wet = rest.filter((h) => h.pop >= 50 || h.precip_mm >= 0.5);
  if (wet.length) {
    const storms = wet.some((h) => h.code >= 95);
    const from = clockLocal(new Date(wet[0]!.t), tz);
    const to = clockLocal(new Date(wet[wet.length - 1]!.t + 3_600_000), tz);
    out.push(`${storms ? "thunderstorms" : "rain"} likely ${from} to ${to} (${Math.max(...wet.map((h) => h.pop))}%)`);
  }
  const hot = Math.max(w.now.feels_c, ...rest.map((h) => h.temp_c));
  const cold = Math.min(w.now.feels_c, ...rest.map((h) => h.temp_c));
  if (hot >= 33) out.push(`hot, up to ${temp(hot, u)}`);
  if (cold <= 2) out.push(`cold, down to ${temp(cold, u)}`);
  const wind = Math.max(w.now.wind_kmh, ...rest.map((h) => h.wind_kmh));
  if (wind >= 40) out.push(`windy, up to ${speed(wind, u)}`);
  const uv = w.days[0]?.uv ?? 0;
  if (uv >= 8) out.push(`UV ${Math.round(uv)}, very high`);
  return out;
}

/** The weather in one line for the situation. */
export function weatherLine(w: Weather, tz: string, u: Units, now = Date.now()): string {
  const today = w.days[0];
  const matters = whatMatters(w, tz, u, now);
  return [
    `${temp(w.now.temp_c, u)} and ${sky(w.now.code)}`,
    today ? `high ${temp(today.max_c, u)}, low ${temp(today.min_c, u)}` : "",
    matters.length ? `worth knowing: ${matters.join("; ")}` : "nothing unusual",
  ]
    .filter(Boolean)
    .join(", ");
}
