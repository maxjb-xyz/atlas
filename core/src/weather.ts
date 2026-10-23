// Weather (VISION §10.1, §10.2): which service answers is an extension
// (§17), Open-Meteo by default. It only ever gets a rough area (coordinates
// rounded to a tenth of a degree, about 10 km), never where you are (§4.4).
// Values are kept metric and said in the owner's units.

import { clockLocal, zonedParts } from "./time";

export type { Day, Hour, Weather } from "../../extensions/sdk";
import type { Weather } from "../../extensions/sdk";

/** A rough area around a point: a tenth of a degree, about 10 km. */
export const roughArea = (p: { lat: number; lon: number }) => ({ lat: Math.round(p.lat * 10) / 10, lon: Math.round(p.lon * 10) / 10 });

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
  // A model that puts a few millimetres in an hour it gives a 1% chance isn't "rain likely": both have to agree somewhat.
  const wet = rest.filter((h) => h.pop >= 50 || (h.pop >= 30 && h.precip_mm >= 0.5));
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
