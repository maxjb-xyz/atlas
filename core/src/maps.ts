// Maps (VISION §19.1): addresses, routes and what's nearby, behind one small
// interface with two providers. OpenStreetMap's free services are the
// default, with no key: Nominatim for addresses, FOSSGIS's OSRM for routes
// and Overpass for places near a route. They're volunteer-run and ask for at
// most one request a second and no heavy use, so calls are paced per host
// and Atlas asks little of them. Mapbox's free tier, by key, adds traffic
// and its own place search; its answers can't be kept, so pins always come
// from Nominatim (or the phone). Every call goes out through the outbox
// (core/src/outbox.ts) with a receipt; these functions only speak HTTP.

import type { LookOut } from "./web";

export type MapsProvider = "osm" | "mapbox";
export type Travel = "drive" | "walk" | "bike";

export interface Point {
  lat: number;
  lon: number;
}

export interface Found extends Point {
  name: string;
  address: string;
  /** What kind of place it is, in the service's words ("supermarket"). */
  kind?: string;
  /** Metres from where the search was centred, or from the route. */
  m?: number;
  /** Minutes off the way, for places along a route. */
  detour_min?: number;
  hours?: string;
}

export interface Route {
  /** Seconds, with traffic when the provider has it. */
  s: number;
  m: number;
  traffic: boolean;
  /** The line to draw, [lon, lat] pairs, simplified. */
  line: Array<[number, number]>;
}

/** Who Atlas says it is to OpenStreetMap's services, as their policies ask: a stable name and where to find it. */
export const USER_AGENT = "Atlas/1.0 (personal assistant; https://github.com/maxjb-xyz/atlas)";

export const MAPS: Record<MapsProvider, { name: string; key: boolean; credit: string }> = {
  osm: { name: "OpenStreetMap", key: false, credit: "© OpenStreetMap contributors" },
  mapbox: { name: "Mapbox", key: true, credit: "© Mapbox © OpenStreetMap contributors" },
};

/** Kinds of place an errand or a search can ask for, with OpenStreetMap's tags and Mapbox's category for each. */
export const KINDS = {
  grocery: { osm: ["shop=supermarket", "shop=grocery"], mapbox: "grocery", words: "a grocery store" },
  convenience: { osm: ["shop=convenience"], mapbox: "convenience_store", words: "a convenience store" },
  pharmacy: { osm: ["amenity=pharmacy", "shop=chemist"], mapbox: "pharmacy", words: "a pharmacy" },
  gas: { osm: ["amenity=fuel"], mapbox: "gas_station", words: "a gas station" },
  coffee: { osm: ["amenity=cafe"], mapbox: "coffee", words: "a coffee shop" },
  restaurant: { osm: ["amenity=restaurant", "amenity=fast_food"], mapbox: "restaurant", words: "a restaurant" },
  hardware: { osm: ["shop=hardware", "shop=doityourself"], mapbox: "hardware_store", words: "a hardware store" },
  bank: { osm: ["amenity=bank", "amenity=atm"], mapbox: "bank", words: "a bank or ATM" },
  post: { osm: ["amenity=post_office"], mapbox: "post_office", words: "a post office" },
  bakery: { osm: ["shop=bakery"], mapbox: "bakery", words: "a bakery" },
  pet: { osm: ["shop=pet"], mapbox: "pet_store", words: "a pet store" },
  electronics: { osm: ["shop=electronics"], mapbox: "electronics_store", words: "an electronics store" },
  clothes: { osm: ["shop=clothes"], mapbox: "clothing_store", words: "a clothes store" },
  charging: { osm: ["amenity=charging_station"], mapbox: "charging_station", words: "an EV charger" },
} as const;
export type PlaceKind = keyof typeof KINDS;
export const PLACE_KINDS = Object.keys(KINDS) as [PlaceKind, ...PlaceKind[]];

/**
 * Any kind of place: one of the common kinds above, an OpenStreetMap tag
 * ("shop=florist", "leisure=park"), or a plain word ("florist"), which is
 * looked for as a shop or an amenity. Mapbox gets the tag's value as its
 * category. Null when it isn't something a map could look for.
 */
export function placeKind(kind: string): { osm: readonly string[]; mapbox: string; words: string } | null {
  const k = kind.trim().toLowerCase();
  if (k in KINDS) return KINDS[k as PlaceKind];
  const tag = /^([a-z_:]{2,30})=([a-z0-9_;:-]{2,40})$/.exec(k);
  if (tag) return { osm: [k], mapbox: tag[2]!, words: tag[2]!.replace(/_/g, " ") };
  if (/^[a-z_]{2,40}$/.test(k)) return { osm: [`shop=${k}`, `amenity=${k}`], mapbox: k, words: k.replace(/_/g, " ") };
  return null;
}

/** A kind of place in words. */
export const kindWords = (kind: string) => placeKind(kind)?.words ?? kind;

// --- pacing ---------------------------------------------------------------------------------------

const lastCall = new Map<string, number>();

/** Waits so calls to one host are at least `gap` ms apart (OpenStreetMap's services ask for one a second). */
async function paced<T>(host: string, gap: number, go: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const at = Math.max(now, (lastCall.get(host) ?? 0) + gap);
  lastCall.set(host, at);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return go();
}

async function getJson<T>(f: typeof fetch, url: string, who: string, init: RequestInit = {}): Promise<LookOut<T>> {
  const host = new URL(url).host;
  const gap = host.endsWith("openstreetmap.org") || host.endsWith("openstreetmap.de") || host.includes("overpass") ? 1_100 : 0;
  let res: Response;
  try {
    res = await paced(host, gap, () =>
      f(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers ?? {}) } }),
    );
  } catch (err) {
    return { ok: false, status: 0, error: `Couldn't reach ${who} (${host}): ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const words = text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const hint =
      res.status === 429 || res.status === 403
        ? `. ${who}'s free service may be refusing this deployment's addresses or asking it to slow down; Settings → Connections → Maps can switch to Mapbox.`
        : res.status === 401
          ? ". Check the Mapbox token in Settings → Connections → Maps."
          : "";
    return { ok: false, status: res.status, error: `${who} (${host}) answered ${res.status}${words ? `: ${words}` : ""}${hint}` };
  }
  try {
    return { ok: true, status: res.status, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, error: `${who} (${host}) answered with something that isn't JSON: ${text.slice(0, 120)}` };
  }
}

const ll = (p: Point) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

// --- addresses -------------------------------------------------------------------------------------

/**
 * Finds an address or a named place. Nominatim's answers may be kept, so
 * pins come from here whichever provider is picked. `near` biases toward a
 * point (about 50 km around it) without ruling out the rest.
 */
export async function geocode(f: typeof fetch, q: string, near?: Point): Promise<LookOut<Found[]>> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "5");
  if (near) u.searchParams.set("viewbox", `${near.lon - 0.5},${near.lat + 0.5},${near.lon + 0.5},${near.lat - 0.5}`);
  const out = await getJson<Array<Record<string, unknown>>>(f, u.toString(), "OpenStreetMap's address search");
  if (!out.ok) return out;
  const value = out.value
    .map((r) => ({
      name: String(r.name || String(r.display_name ?? "").split(",")[0] || q),
      address: String(r.display_name ?? ""),
      lat: num(r.lat),
      lon: num(r.lon),
      ...(r.type ? { kind: String(r.type) } : {}),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  return { ...out, value };
}

/** The address at a point, for "where am I?" when it isn't a saved place. */
export async function reverse(f: typeof fetch, p: Point): Promise<LookOut<Found>> {
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("lat", p.lat.toFixed(6));
  u.searchParams.set("lon", p.lon.toFixed(6));
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("zoom", "18");
  const out = await getJson<Record<string, unknown>>(f, u.toString(), "OpenStreetMap's address search");
  if (!out.ok) return out;
  if (out.value.error) return { ok: false, status: out.status, error: `OpenStreetMap has no address there: ${String(out.value.error)}` };
  return {
    ...out,
    value: {
      name: String(out.value.name || String(out.value.display_name ?? "").split(",")[0]),
      address: String(out.value.display_name ?? ""),
      ...p,
    },
  };
}

// --- routes ------------------------------------------------------------------------------------------

const OSRM = { drive: "routed-car", walk: "routed-foot", bike: "routed-bike" } as const;
const MAPBOX_PROFILE = { drive: "driving-traffic", walk: "walking", bike: "cycling" } as const;

/** A route through the points in order, by `travel`. */
export async function route(
  f: typeof fetch,
  o: { provider: MapsProvider; key: string | null; via: Point[]; travel: Travel },
): Promise<LookOut<Route>> {
  const coords = o.via.map(ll).join(";");
  if (o.provider === "mapbox") {
    if (!o.key) return { ok: false, status: 0, error: "Mapbox needs its token: Settings → Connections → Maps." };
    const u = `https://api.mapbox.com/directions/v5/mapbox/${MAPBOX_PROFILE[o.travel]}/${coords}?geometries=geojson&overview=simplified&access_token=${encodeURIComponent(o.key)}`;
    const out = await getJson<{
      routes?: Array<{ duration: number; distance: number; geometry?: { coordinates?: Array<[number, number]> } }>;
      message?: string;
    }>(f, u, "Mapbox");
    if (!out.ok) return out;
    const r = out.value.routes?.[0];
    if (!r) return { ok: false, status: out.status, error: `Mapbox found no route${out.value.message ? `: ${out.value.message}` : ""}.` };
    return { ...out, value: { s: r.duration, m: r.distance, traffic: o.travel === "drive", line: r.geometry?.coordinates ?? [] } };
  }
  const u = `https://routing.openstreetmap.de/${OSRM[o.travel]}/route/v1/driving/${coords}?overview=simplified&geometries=geojson`;
  const out = await getJson<{
    code?: string;
    message?: string;
    routes?: Array<{ duration: number; distance: number; geometry?: { coordinates?: Array<[number, number]> } }>;
  }>(f, u, "OpenStreetMap's routing");
  if (!out.ok) return out;
  const r = out.value.routes?.[0];
  if (out.value.code !== "Ok" || !r) {
    return {
      ok: false,
      status: out.status,
      error: `OpenStreetMap's routing found no route: ${out.value.message ?? out.value.code ?? "no answer"}.`,
    };
  }
  return { ...out, value: { s: r.duration, m: r.distance, traffic: false, line: r.geometry?.coordinates ?? [] } };
}

// --- places nearby --------------------------------------------------------------------------------------

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

function metresBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/** How far a point is from a line, in metres (to the nearest of its sample points; close enough to rank by). */
export function offLine(p: Point, pts: Point[]): number {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, metresBetween(p, q));
  return best;
}

/**
 * Places of a kind, or by name, near a point or along a line (a route).
 * OpenStreetMap: one Overpass query. Mapbox: its category search, along
 * the route when there is one.
 */
export async function nearby(
  f: typeof fetch,
  o: {
    provider: MapsProvider;
    key: string | null;
    kind?: string;
    name?: string;
    near: Point;
    /** A route to search along, as [lon, lat] pairs. */
    along?: Array<[number, number]>;
    /** How far from the point (or the route) counts, in metres. */
    within: number;
    limit: number;
  },
): Promise<LookOut<Found[]>> {
  const kind = o.kind ? placeKind(o.kind) : null;
  if (o.kind && !kind)
    return {
      ok: false,
      status: 0,
      error: `"${o.kind}" isn't a kind of place a map can look for; try a word like "florist" or a tag like "leisure=park".`,
    };
  if (o.provider === "mapbox" && kind) {
    if (!o.key) return { ok: false, status: 0, error: "Mapbox needs its token: Settings → Connections → Maps." };
    const u = new URL(`https://api.mapbox.com/search/searchbox/v1/category/${encodeURIComponent(kind.mapbox)}`);
    u.searchParams.set("access_token", o.key);
    u.searchParams.set("proximity", ll(o.near));
    u.searchParams.set("limit", String(Math.min(25, o.limit)));
    if (o.along?.length) {
      u.searchParams.set("sar_type", "isochrone");
      u.searchParams.set("route", polyline(o.along, 6));
      u.searchParams.set("route_geometry", "polyline6");
      u.searchParams.set("time_deviation", String(Math.max(1, Math.round(o.within / 400))));
    }
    const out = await getJson<{
      features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> }>;
    }>(f, u.toString(), "Mapbox");
    if (!out.ok) return out;
    const value = (out.value.features ?? [])
      .map((x) => {
        const [lon, lat] = x.geometry?.coordinates ?? [NaN, NaN];
        const p = x.properties ?? {};
        return {
          name: String(p.name ?? ""),
          address: String(p.full_address ?? p.address ?? p.place_formatted ?? ""),
          lat,
          lon,
          kind: Array.isArray(p.poi_category) ? String(p.poi_category[0]) : kind.mapbox,
          ...(typeof p.distance === "number" ? { m: Math.round(p.distance) } : {}),
        };
      })
      .filter((x) => x.name && Number.isFinite(x.lat));
    return { ...out, value };
  }
  const pts = o.along?.length ? samples(o.along, Math.max(200, o.within)) : [o.near];
  const around = pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(",");
  const filters = kind
    ? kind.osm.map((t) => {
        const [k, v] = t.split("=");
        return `["${k}"="${v}"]`;
      })
    : [`["name"~"${(o.name ?? "").replace(/["\\]/g, "").slice(0, 60)}",i]`];
  const body = filters.flatMap((flt) => [
    `node${flt}(around:${Math.round(o.within)},${around});`,
    `way${flt}(around:${Math.round(o.within)},${around});`,
  ]);
  const query = `[out:json][timeout:20];(${body.join("")});out center tags 60;`;
  const out = await getJson<{
    elements?: Array<{ lat?: number; lon?: number; center?: Point; tags?: Record<string, string> }>;
    remark?: string;
  }>(f, "https://overpass-api.de/api/interpreter", "OpenStreetMap's place search", {
    method: "POST",
    body: new URLSearchParams({ data: query }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!out.ok) return out;
  if (!out.value.elements && out.value.remark)
    return { ok: false, status: out.status, error: `OpenStreetMap's place search: ${out.value.remark}` };
  const seen = new Set<string>();
  const value = (out.value.elements ?? [])
    .map((e) => {
      const t = e.tags ?? {};
      const p = { lat: e.lat ?? e.center?.lat ?? NaN, lon: e.lon ?? e.center?.lon ?? NaN };
      const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      return {
        name: t.name ?? t.brand ?? "",
        address: [street, t["addr:city"]].filter(Boolean).join(", "),
        ...p,
        kind: t.shop ?? t.amenity ?? "",
        m: Math.round(o.along?.length ? offLine(p, pts) : metresBetween(p, o.near)),
        ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      };
    })
    .filter(
      (x) =>
        x.name &&
        Number.isFinite(x.lat) &&
        !seen.has(`${x.name}|${x.lat.toFixed(3)}|${x.lon.toFixed(3)}`) &&
        seen.add(`${x.name}|${x.lat.toFixed(3)}|${x.lon.toFixed(3)}`),
    )
    .sort((a, b) => a.m - b.m)
    .slice(0, o.limit);
  return { ...out, value };
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

/** "12 min", "1 h 5 min". */
export function minutes(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
