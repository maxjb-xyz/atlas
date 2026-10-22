// Location as a sense (VISION §10.1): OwnTracks on the owner's phone posts
// fixes and region events to the Worker, and the agent keeps the latest fix
// in its state. The log gets a `sense` row only when something happened:
// arriving at a saved place, leaving it, a real move away from saved places,
// or location turned off or on. Arrivals and departures come from one state
// machine here, fed by both the phone's own region events and plain fixes,
// so each one is logged once whichever comes first. Saved places with a pin
// go back to the phone as OwnTracks regions, in the answer to a post.

import type { Sql } from "./store/db";
import { append, type LogRow } from "./store/log";
import { type AtlasRecord, findRecords } from "./store/records";
import { getSecret, setSecret } from "./store/settings";
import { getState, setState } from "./store/state";

/** One position from the phone. */
export interface Fix {
  lat: number;
  lon: number;
  /** Accuracy in metres. */
  acc: number;
  at: number;
  /** Battery, 0 to 100. */
  batt?: number;
  charging?: boolean;
  conn?: "wifi" | "mobile" | "offline";
  /** Speed in km/h. */
  speed?: number;
  /** What the phone thinks you're doing: walking, automotive, stationary. */
  motion?: string[];
}

/** A saved place Atlas can notice you at: a place or organization record with a pin. */
export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

/** Where the owner is, as far as Atlas knows. Kept in state (`location`), rebuilt from what the phone sends. */
export interface Here {
  fix: Fix | null;
  /** The saved place they're at, and since when. */
  place: { id: string; name: string; since: number } | null;
  /** The last place they left, and when. */
  left: { id: string; name: string; at: number } | null;
  /** Where the last logged move was, so the next is logged only after a real move. */
  anchor: { lat: number; lon: number; at: number } | null;
  /** A hash of the regions the phone was last sent, so they go again only when they change. */
  regions: string;
  /** The last post with the wrong password, and how many in a row. */
  refused: { at: number; n: number } | null;
}

const EMPTY: Here = { fix: null, place: null, left: null, anchor: null, regions: "", refused: null };

export const here = (sql: Sql): Here => ({ ...EMPTY, ...(getState<Partial<Here>>(sql, "location") ?? {}) });
const save = (sql: Sql, h: Here) => setState(sql, "location", h);

/** A place's radius when it has none: about a building and its car park. */
export const DEFAULT_RADIUS_M = 120;
/** Away from saved places, a move this far from the last logged one is logged. */
export const MOVE_M = 1_000;
/** Leaving needs this much past the radius, or the fix's accuracy if worse (up to 300 m), so a jumpy fix doesn't leave and come back. */
const LEAVE_MARGIN_M = 60;

/** Metres between two points (haversine). */
export function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The pin of a place record, when it has one. */
export function pinOf(r: AtlasRecord): Pin | null {
  const lat = num(r.fields.lat);
  const lon = num(r.fields.lon);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { id: r.id, name: r.name, lat, lon, radius_m: Math.max(30, Math.min(2_000, num(r.fields.radius_m) ?? DEFAULT_RADIUS_M)) };
}

/** Every saved place with a pin. */
export function pins(sql: Sql): Pin[] {
  return [...findRecords(sql, "place"), ...findRecords(sql, "organization")].map(pinOf).filter((p): p is Pin => p != null);
}

/** The owner's home, when it's a saved place with a pin: a place named Home, or one noted as their home. */
export function homePin(sql: Sql): Pin | null {
  const all = [...findRecords(sql, "place"), ...findRecords(sql, "organization")];
  const home =
    all.find((r) => r.name.trim().toLowerCase() === "home" && pinOf(r)) ??
    all.find((r) => r.fields.is_home === true && pinOf(r)) ??
    all.find((r) => /\b(my|our|owner's) (home|house|apartment|flat)\b/i.test(String(r.fields.fact ?? "")) && pinOf(r));
  return home ? pinOf(home) : null;
}

/** The nearest pin and how far, or null when there are none. */
export function nearest(all: Pin[], at: { lat: number; lon: number }): { pin: Pin; m: number } | null {
  let best: { pin: Pin; m: number } | null = null;
  for (const pin of all) {
    const m = metres(pin, at);
    if (!best || m < best.m) best = { pin, m };
  }
  return best;
}

// --- what OwnTracks sends ------------------------------------------------------------------------

export type Observation =
  | { kind: "fix"; fix: Fix }
  /** The phone's own region event: it knows the region by the place's id (rid). */
  | { kind: "region"; event: "enter" | "leave"; rid: string; fix: Fix };

/**
 * Reads one OwnTracks post (its JSON payload) as observations. Anything
 * else it sends (waypoint lists, cards, status) is left alone.
 */
export function readOwnTracks(body: unknown): Observation[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const lat = num(b.lat);
  const lon = num(b.lon);
  const tst = num(b.tst);
  if (lat == null || lon == null || tst == null) return [];
  const motion = Array.isArray(b.motionactivities) ? b.motionactivities.filter((m): m is string => typeof m === "string") : [];
  const fix: Fix = {
    lat,
    lon,
    acc: Math.max(0, num(b.acc) ?? 0),
    at: tst * 1000,
    ...(num(b.batt) != null ? { batt: num(b.batt)! } : {}),
    ...(num(b.bs) != null ? { charging: b.bs === 2 || b.bs === 3 } : {}),
    ...(b.conn === "w"
      ? { conn: "wifi" as const }
      : b.conn === "m"
        ? { conn: "mobile" as const }
        : b.conn === "o"
          ? { conn: "offline" as const }
          : {}),
    ...(num(b.vel) != null ? { speed: num(b.vel)! } : {}),
    ...(motion.length ? { motion } : {}),
  };
  if (b._type === "location") return [{ kind: "fix", fix }];
  if (b._type === "transition" && (b.event === "enter" || b.event === "leave") && typeof b.rid === "string") {
    return [{ kind: "region", event: b.event, rid: b.rid, fix }];
  }
  return [];
}

// --- the state machine -----------------------------------------------------------------------------

/** What happened, for the log: a `sense` row's body. */
export type SenseBody =
  | { source: "location"; event: "arrived"; place: { id: string; name: string }; lat: number; lon: number; acc: number }
  | {
      source: "location";
      event: "left";
      place: { id: string; name: string };
      stayed_ms: number;
      lat: number;
      lon: number;
      acc: number;
    }
  | {
      source: "location";
      event: "moved";
      lat: number;
      lon: number;
      acc: number;
      /** The nearest saved place and how far, in metres. */
      near: { name: string; m: number } | null;
      motion?: string[];
    }
  | { source: "location"; event: "off" | "on" };

/**
 * Takes in one observation and returns what happened, if anything. A fix
 * older than the one Atlas has is ignored (OwnTracks sends what it queued
 * offline late); a region event still counts, since the phone saw it.
 */
export function observe(sql: Sql, o: Observation): SenseBody[] {
  const h = here(sql);
  const all = pins(sql);
  const out: SenseBody[] = [];
  const fix = o.fix;
  const newer = !h.fix || fix.at >= h.fix.at;
  const at = { lat: fix.lat, lon: fix.lon, acc: Math.round(fix.acc) };

  const arrive = (pin: Pin) => {
    h.place = { id: pin.id, name: pin.name, since: fix.at };
    h.anchor = { lat: pin.lat, lon: pin.lon, at: fix.at };
    out.push({ source: "location", event: "arrived", place: { id: pin.id, name: pin.name }, ...at });
  };
  const leave = () => {
    const p = h.place!;
    h.left = { id: p.id, name: p.name, at: fix.at };
    h.place = null;
    h.anchor = { lat: fix.lat, lon: fix.lon, at: fix.at };
    out.push({ source: "location", event: "left", place: { id: p.id, name: p.name }, stayed_ms: Math.max(0, fix.at - p.since), ...at });
  };

  if (o.kind === "region") {
    const pin = all.find((p) => p.id === o.rid);
    if (pin && o.event === "enter" && h.place?.id !== pin.id) {
      if (h.place) leave();
      arrive(pin);
    } else if (pin && o.event === "leave" && h.place?.id === pin.id) {
      leave();
    }
  } else if (newer) {
    const inPlace = h.place ? all.find((p) => p.id === h.place!.id) : undefined;
    // A place deleted or unpinned since: it's left without a word, since nothing happened.
    if (h.place && !inPlace) h.place = null;
    if (inPlace) {
      const margin = Math.max(LEAVE_MARGIN_M, Math.min(fix.acc, 300));
      if (metres(inPlace, fix) > inPlace.radius_m + margin) leave();
    }
    if (!h.place && fix.acc <= 250) {
      const inside = all
        .map((pin) => ({ pin, m: metres(pin, fix) }))
        .filter((x) => x.m <= x.pin.radius_m)
        .sort((a, b) => a.m - b.m)[0];
      if (inside) arrive(inside.pin);
    }
    if (!h.place && fix.acc <= 500 && (!h.anchor || metres(h.anchor, fix) >= MOVE_M)) {
      const n = nearest(all, fix);
      h.anchor = { lat: fix.lat, lon: fix.lon, at: fix.at };
      out.push({
        source: "location",
        event: "moved",
        ...at,
        near: n ? { name: n.pin.name, m: Math.round(n.m) } : null,
        ...(fix.motion?.length ? { motion: fix.motion } : {}),
      });
    }
  }
  if (newer) h.fix = fix;
  save(sql, h);
  return out;
}

/** Writes what happened as `sense` rows. */
export function logSense(sql: Sql, bodies: SenseBody[], at?: number): LogRow[] {
  return bodies.map((body) => append(sql, { actor: "system", kind: "sense", body: body as never, ...(at ? { at } : {}) }));
}

/** Location turned off: the fix and the place are dropped, so nothing is guessed from them. */
export function locationOff(sql: Sql): LogRow[] {
  const h = here(sql);
  save(sql, { ...EMPTY, regions: h.regions, refused: h.refused });
  return logSense(sql, [{ source: "location", event: "off" }]);
}

export function locationOn(sql: Sql): LogRow[] {
  return logSense(sql, [{ source: "location", event: "on" }]);
}

// --- OwnTracks' sign-in and answer -------------------------------------------------------------------

export interface OwnTracksLogin {
  user: string;
  password: string;
  made_at: number;
}

export const ownTracksLogin = (sql: Sql): OwnTracksLogin | null => getSecret<OwnTracksLogin>(sql, "owntracks");

/** Makes OwnTracks' own user and password, replacing any before (so an old phone setup stops working). */
export function newOwnTracksLogin(sql: Sql): OwnTracksLogin {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const password = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const login = { user: "atlas", password, made_at: Date.now() };
  setSecret(sql, "owntracks", login);
  return login;
}

/** Whether an Authorization header carries OwnTracks' user and password. Compared in constant time. */
export function ownTracksAllowed(sql: Sql, authorization: string | null): boolean {
  const login = ownTracksLogin(sql);
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization?.trim() ?? "");
  if (!login || !m) return false;
  let given = "";
  try {
    given = atob(m[1]!);
  } catch {
    return false;
  }
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(`${login.user}:${login.password}`);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Notes a refused post, for Settings → Devices. */
export function refused(sql: Sql): void {
  const h = here(sql);
  save(sql, { ...h, refused: { at: Date.now(), n: (h.refused?.n ?? 0) + 1 } });
}

/** One OwnTracks waypoint. An impossible latitude removes the region on the phone. */
const waypoint = (p: { id: string; name: string; lat: number; lon: number; radius_m: number }, tst: number) => ({
  _type: "waypoint",
  desc: p.name.replace(/:/g, " "),
  rid: p.id,
  lat: p.lat,
  lon: p.lon,
  rad: Math.round(p.radius_m),
  tst,
});

const hashOf = (all: Pin[]) => all.map((p) => `${p.id}|${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}|${p.radius_m}`).join(";");

/**
 * What to answer OwnTracks: nothing usually, or the saved places as
 * regions when they changed since the phone was last sent them (removed
 * ones with an impossible latitude, which OwnTracks takes as delete).
 */
export function ownTracksAnswer(sql: Sql): unknown[] {
  const h = here(sql);
  const all = pins(sql);
  const hash = hashOf(all);
  if (hash === h.regions) return [];
  const sent = new Set(all.map((p) => p.id));
  const gone = h.regions
    .split(";")
    .filter(Boolean)
    .map((s) => s.split("|"))
    .filter(([id]) => id && !sent.has(id))
    .map(([id, name]) => ({ id: id!, name: name ?? "", lat: 91, lon: 0, radius_m: 0 }));
  save(sql, { ...h, regions: hash });
  const tst = Math.floor(Date.now() / 1000);
  return [
    {
      _type: "cmd",
      action: "setWaypoints",
      waypoints: { _type: "waypoints", waypoints: [...all.map((p) => waypoint(p, tst)), ...gone.map((p) => waypoint(p, tst))] },
    },
  ];
}

/**
 * The OwnTracks configuration for a one-tap setup: HTTP mode to this
 * deployment, its own user and password, significant-changes monitoring
 * (light on the battery, with regions for arrivals), remote commands on so
 * Atlas can send the regions, and the regions themselves.
 */
export function ownTracksConfig(sql: Sql, origin: string, login: OwnTracksLogin) {
  const tst = Math.floor(Date.now() / 1000);
  return {
    _type: "configuration",
    mode: 3,
    url: `${origin}/owntracks`,
    auth: true,
    username: login.user,
    password: login.password,
    deviceId: "phone",
    tid: "me",
    monitoring: 1,
    locatorDisplacement: 200,
    locatorInterval: 300,
    extendedData: true,
    cmd: true,
    remoteConfiguration: true,
    allowRemoteLocation: true,
    waypoints: pins(sql).map((p) => waypoint(p, tst)),
  };
}

/** The link that opens OwnTracks with the configuration filled in. */
export function ownTracksLink(config: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `owntracks:///config?inline=${encodeURIComponent(btoa(s))}`;
}
