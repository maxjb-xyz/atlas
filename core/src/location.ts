// Location as a sense (VISION §10.1): a location extension (§17), OwnTracks
// on the owner's phone by default, posts fixes and region events, and the
// agent keeps the latest fix in its state. The log gets a `sense` row only
// when something happened: arriving at a saved place, leaving it, a real
// move away from saved places, or location turned off or on. Arrivals and
// departures come from one state machine here, fed by both the phone's own
// region events and plain fixes, so each one is logged once whichever comes
// first. The saved places are what the extension gives the phone as regions.

import type { Sql } from "./store/db";
import { append, type LogRow } from "./store/log";
import { type AtlasRecord, findRecords, getRecord } from "./store/records";
import { getState, setState } from "./store/state";

export type { Fix } from "../../extensions/sdk";
import type { Fix, Transition } from "../../extensions/sdk";

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
  /** Kept by deployments from before location was an extension; the extension keeps what the phone was sent now. */
  regions?: string;
  /** The last post with the wrong password, and how many in a row. */
  refused: { at: number; n: number } | null;
}

const EMPTY: Here = { fix: null, place: null, left: null, anchor: null, refused: null };

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

/**
 * A saved place by id or name, the way people say it: any case, and loosely,
 * so "UCF Recreation and Wellness Center" and "RWC" both find
 * "UCF Recreation and Wellness Center (RWC)". An exact name wins, then one
 * that holds the words, then one whose short name in brackets matches.
 */
export function findPlace(sql: Sql, ref: string): AtlasRecord | null {
  const r = getRecord(sql, ref);
  if (r && r.state === "active" && (r.type === "place" || r.type === "organization")) return r;
  const all = [...findRecords(sql, "place"), ...findRecords(sql, "organization")];
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const want = norm(ref);
  if (!want) return null;
  return (
    all.find((p) => norm(p.name) === want) ??
    all.find((p) => norm(p.name).includes(want) || (want.length > 4 && want.includes(norm(p.name)))) ??
    all.find((p) => /\(([^)]+)\)/.exec(p.name)?.[1]?.toLowerCase().trim() === want) ??
    null
  );
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

// --- what the phone sends ---------------------------------------------------------------------------------

export type Observation =
  | { kind: "fix"; fix: Fix }
  /** The phone's own region event: it knows the region by the place's id (rid). */
  | { kind: "region"; event: "enter" | "leave"; rid: string; fix: Fix };

/** What a location extension read from a post, as observations, oldest first. */
export const observations = (r: { fixes?: Fix[]; transitions?: Transition[] }): Observation[] =>
  [
    ...(r.fixes ?? []).map((fix): Observation => ({ kind: "fix", fix })),
    ...(r.transitions ?? []).map((t): Observation => ({ kind: "region", event: t.event, rid: t.place, fix: t.fix })),
  ].sort((a, b) => a.fix.at - b.fix.at);

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

// --- the phone's sign-in -----------------------------------------------------------------------------------

/** A post with the right password came: an earlier refused one isn't news any more. */
export function allowedPost(sql: Sql): void {
  const h = here(sql);
  if (h.refused) save(sql, { ...h, refused: null });
}

/** Notes a refused post, for Abilities → Devices. */
export function refused(sql: Sql): void {
  const h = here(sql);
  save(sql, { ...h, refused: { at: Date.now(), n: (h.refused?.n ?? 0) + 1 } });
}
