// Small geometry for maps providers: distances, points along a route, and encoded polylines.

import type { Point } from "../sdk";

export function metresBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/** A point every ~`step` metres along a line, so a search along a route covers it without a huge query. */
export function samples(line: Array<[number, number]>, step: number, max = 40): Point[] {
  if (!line.length) return [];
  const out: Point[] = [{ lon: line[0]![0], lat: line[0]![1] }];
  let since = 0;
  for (let i = 1; i < line.length; i++) {
    const a = { lon: line[i - 1]![0], lat: line[i - 1]![1] };
    const b = { lon: line[i]![0], lat: line[i]![1] };
    since += metresBetween(a, b);
    if (since >= step) {
      out.push(b);
      since = 0;
    }
  }
  const last = line[line.length - 1]!;
  out.push({ lon: last[0], lat: last[1] });
  if (out.length <= max) return out;
  const every = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * every)]!);
}

/** How far a point is from a line, in metres (to the nearest of its sample points; close enough to rank by). */
export function offLine(p: Point, pts: Point[]): number {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, metresBetween(p, q));
  return best;
}

/** Google's encoded polyline, at 5 or 6 decimal places, from [lon, lat] pairs. */
export function polyline(line: Array<[number, number]>, precision = 5): string {
  const factor = 10 ** precision;
  let out = "";
  let lastLat = 0;
  let lastLon = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (x >= 0x20) {
      s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    return s + String.fromCharCode(x + 63);
  };
  for (const [lon, lat] of line) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    out += enc(la - lastLat) + enc(lo - lastLon);
    lastLat = la;
    lastLon = lo;
  }
  return out;
}

export const ll = (p: Point) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
export const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
