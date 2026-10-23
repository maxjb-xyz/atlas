// Mapbox (VISION §19.1): routes with live traffic and its own place search,
// by key, on its free tier. Its answers can't be kept, so pins (addresses)
// come from OpenStreetMap's extension instead; this one has no geocode.

import { type Extension, type Kind, Failure, get, json } from "../sdk";
import { ll, polyline } from "../lib/geo";

const PROFILE = { drive: "driving-traffic", walk: "walking", bike: "cycling" } as const;

/** Mapbox's category for a kind of place: its own name where it differs from OpenStreetMap's tag, else the tag's value. */
const CATEGORY: Record<string, string> = {
  supermarket: "grocery",
  convenience: "convenience_store",
  fuel: "gas_station",
  cafe: "coffee",
  hardware: "hardware_store",
  atm: "bank",
  pet: "pet_store",
  electronics: "electronics_store",
  clothes: "clothing_store",
};
const categoryOf = (k: Kind) => {
  const v = k.osm[0]?.split("=")[1] ?? k.words;
  return CATEGORY[v] ?? v;
};

const ext: Extension = {
  manifest: {
    id: "mapbox",
    name: "Mapbox",
    version: "1.0.0",
    about: "Routes with live traffic, and Mapbox's place search, on its free tier. Addresses for pins still come from OpenStreetMap.",
    provides: ["maps"],
    hosts: ["api.mapbox.com"],
    secrets: [
      {
        name: "token",
        label: "Mapbox public token",
        help: "Make a free Mapbox account and copy its default public token from account.mapbox.com.",
      },
    ],
    credit: "© Mapbox © OpenStreetMap contributors",
  },
  async route(ctx, { via, travel }) {
    const u = `https://api.mapbox.com/directions/v5/mapbox/${PROFILE[travel]}/${via.map(ll).join(";")}?geometries=geojson&overview=simplified&access_token=${ctx.secret("token")}`;
    const out = await json<{
      routes?: Array<{ duration: number; distance: number; geometry?: { coordinates?: Array<[number, number]> } }>;
      message?: string;
    }>(await get(u, {}, "Mapbox"), "Mapbox");
    const r = out.routes?.[0];
    if (!r) throw new Failure(`Mapbox found no route${out.message ? `: ${out.message}` : ""}.`);
    return { s: r.duration, m: r.distance, traffic: travel === "drive", line: r.geometry?.coordinates ?? [] };
  },
  async nearby(ctx, o) {
    if (!o.kind)
      throw new Failure("Mapbox's place search here looks for kinds of places; a search by name goes to OpenStreetMap.", "protocol");
    const u = new URL(`https://api.mapbox.com/search/searchbox/v1/category/${encodeURIComponent(categoryOf(o.kind))}`);
    u.searchParams.set("access_token", ctx.secret("token"));
    u.searchParams.set("proximity", ll(o.near));
    u.searchParams.set("limit", String(Math.min(25, o.limit)));
    if (o.along?.length) {
      u.searchParams.set("sar_type", "isochrone");
      u.searchParams.set("route", polyline(o.along, 6));
      u.searchParams.set("route_geometry", "polyline6");
      u.searchParams.set("time_deviation", String(Math.max(1, Math.round(o.within / 400))));
    }
    const out = await json<{ features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> }> }>(
      await get(u.toString(), {}, "Mapbox"),
      "Mapbox",
    );
    return (out.features ?? [])
      .map((x) => {
        const [lon, lat] = x.geometry?.coordinates ?? [NaN, NaN];
        const p = x.properties ?? {};
        return {
          name: String(p.name ?? ""),
          address: String(p.full_address ?? p.address ?? p.place_formatted ?? ""),
          lat,
          lon,
          kind: Array.isArray(p.poi_category) ? String(p.poi_category[0]) : categoryOf(o.kind!),
          ...(typeof p.distance === "number" ? { m: Math.round(p.distance) } : {}),
        };
      })
      .filter((x) => x.name && Number.isFinite(x.lat));
  },
  async test(ctx) {
    const r = await ext.route!(ctx, {
      via: [
        { lat: 40.7128, lon: -74.006 },
        { lat: 40.7306, lon: -73.9866 },
      ],
      travel: "drive",
    });
    return { text: `Mapbox works: a test route took ${Math.max(1, Math.round(r.s / 60))} min with traffic.` };
  },
};

export default ext;
