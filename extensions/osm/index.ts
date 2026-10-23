// OpenStreetMap's free services (VISION §19.1), with no key: Nominatim for
// addresses, FOSSGIS's OSRM for routes, and Overpass for places near a
// route. They're volunteer-run and ask for at most one request a second and
// no heavy use, so the core spaces calls out, and Atlas asks little of them.
// Their answers may be kept, so pins come from here whichever maps provider
// is picked.

import { type Extension, type Found, type Kind, type Point, Failure, get } from "../sdk";
import { ll, metresBetween, num, offLine, samples } from "../lib/geo";

const UA = "Atlas/1.0 (personal assistant; https://github.com/maxjb-xyz/atlas)";
/** Overpass's public servers, tried in turn: the main one is often busy, and from Cloudflare it has timed out where the others answered. */
const OVERPASS = ["overpass-api.de", "overpass.private.coffee", "maps.mail.ru/osm/tools/overpass"];
const OSRM = { drive: "routed-car", walk: "routed-foot", bike: "routed-bike" } as const;

async function getJson<T>(url: string, who: string, init: RequestInit = {}): Promise<T> {
  const host = new URL(url).host;
  const res = await get(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) } }, who);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const words = text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const hint =
      res.status === 429 || res.status === 403
        ? `. ${who}'s free service may be refusing this deployment's addresses or asking it to slow down; Mapbox's extension is another way.`
        : "";
    throw new Failure(
      `${who} (${host}) answered ${res.status}${words ? `: ${words}` : ""}${hint}`,
      res.status >= 500 || res.status === 429 ? "network" : "protocol",
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Failure(`${who} (${host}) answered with something that isn't JSON: ${text.slice(0, 120)}`);
  }
}

/** A place search with Nominatim, bounded to the point's area or the route's box, filtered to the kind and to near the route. */
async function nominatimIn(
  o: { name?: string; near: Point; along?: Array<[number, number]>; within: number; limit: number },
  kind: Kind | null,
  pts: Point[],
): Promise<Found[]> {
  const values = kind ? kind.osm.map((t) => t.split("=")[1]!) : [];
  const q = o.name ?? values[0]?.replace(/_/g, " ");
  if (!q) return [];
  const d = o.within / 111_000;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "40");
  u.searchParams.set("bounded", "1");
  u.searchParams.set("viewbox", `${Math.min(...lons) - d},${Math.max(...lats) + d},${Math.max(...lons) + d},${Math.min(...lats) - d}`);
  const out = await getJson<Array<Record<string, unknown>>>(u.toString(), "OpenStreetMap's address search");
  return out
    .filter((r) => !kind || values.includes(String(r.type ?? "")))
    .map((r) => {
      const p = { lat: num(r.lat), lon: num(r.lon) };
      return {
        name: String(r.name || String(r.display_name ?? "").split(",")[0] || q),
        address: String(r.display_name ?? ""),
        ...p,
        kind: String(r.type ?? ""),
        m: Math.round(o.along?.length ? offLine(p, pts) : metresBetween(p, o.near)),
      };
    })
    .filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lon) && x.m <= o.within * 1.5)
    .sort((a, b) => a.m - b.m)
    .slice(0, Math.max(o.limit, 8));
}

const ext: Extension = {
  manifest: {
    id: "osm",
    name: "OpenStreetMap",
    version: "1.0.0",
    about: "Addresses, routes and places from OpenStreetMap's free services. No key; no live traffic.",
    provides: ["maps"],
    hosts: ["nominatim.openstreetmap.org", "routing.openstreetmap.de", "overpass-api.de", "overpass.private.coffee", "maps.mail.ru"],
    pace_ms: 1_100,
    credit: "© OpenStreetMap contributors",
  },
  async geocode(_ctx, { q, near }) {
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("q", q);
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("limit", "5");
    if (near) u.searchParams.set("viewbox", `${near.lon - 0.5},${near.lat + 0.5},${near.lon + 0.5},${near.lat - 0.5}`);
    const out = await getJson<Array<Record<string, unknown>>>(u.toString(), "OpenStreetMap's address search");
    return out
      .map((r) => ({
        name: String(r.name || String(r.display_name ?? "").split(",")[0] || q),
        address: String(r.display_name ?? ""),
        lat: num(r.lat),
        lon: num(r.lon),
        ...(r.type ? { kind: String(r.type) } : {}),
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  },
  async reverse(_ctx, p) {
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("lat", p.lat.toFixed(6));
    u.searchParams.set("lon", p.lon.toFixed(6));
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("zoom", "18");
    const out = await getJson<Record<string, unknown>>(u.toString(), "OpenStreetMap's address search");
    if (out.error) throw new Failure(`OpenStreetMap has no address there: ${String(out.error)}`);
    return {
      name: String(out.name || String(out.display_name ?? "").split(",")[0]),
      address: String(out.display_name ?? ""),
      lat: p.lat,
      lon: p.lon,
    };
  },
  async route(_ctx, { via, travel }) {
    const u = `https://routing.openstreetmap.de/${OSRM[travel]}/route/v1/driving/${via.map(ll).join(";")}?overview=simplified&geometries=geojson`;
    const out = await getJson<{
      code?: string;
      message?: string;
      routes?: Array<{ duration: number; distance: number; geometry?: { coordinates?: Array<[number, number]> } }>;
    }>(u, "OpenStreetMap's routing");
    const r = out.routes?.[0];
    if (out.code !== "Ok" || !r) throw new Failure(`OpenStreetMap's routing found no route: ${out.message ?? out.code ?? "no answer"}.`);
    return { s: r.duration, m: r.distance, traffic: false, line: r.geometry?.coordinates ?? [] };
  },
  async nearby(_ctx, o) {
    const kind = o.kind ?? null;
    const pts = o.along?.length ? samples(o.along, Math.max(200, o.within)) : [o.near];
    // Nominatim first, bounded to the area: it answers from Cloudflare where Overpass's public servers have timed out,
    // it knows short names, and a kind ("pharmacy") is one of its special phrases. Overpass is the fallback.
    let first: Found[] = [];
    let firstError = "";
    try {
      first = await nominatimIn(o, kind, pts);
      if (first.length) return first;
    } catch (err) {
      firstError = err instanceof Error ? err.message : String(err);
    }
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
    type Answer = { elements?: Array<{ lat?: number; lon?: number; center?: Point; tags?: Record<string, string> }>; remark?: string };
    let out: Answer | null = null;
    const tried: string[] = [];
    for (const server of OVERPASS) {
      try {
        out = await getJson<Answer>(`https://${server}/api/interpreter`, "OpenStreetMap's place search", {
          method: "POST",
          body: new URLSearchParams({ data: query }).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          // Ten seconds each, so all three fit in place_find's time; a slow one is as good as down.
          signal: AbortSignal.timeout(10_000),
        });
        break;
      } catch (err) {
        // A busy or unreachable server (429, 5xx, no answer) means the next one; anything else is the answer.
        if (err instanceof Failure && err.code !== "network" && err.status) throw err;
        tried.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (!out)
      throw new Failure(`${firstError || "Nominatim found none"}, and every Overpass server failed: ${tried.join(" · ")}`, "network");
    if (!out.elements && out.remark) throw new Failure(`OpenStreetMap's place search: ${out.remark}`);
    const seen = new Set<string>();
    return (out.elements ?? [])
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
  },
};

export default ext;
