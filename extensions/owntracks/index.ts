// OwnTracks (VISION §10.1): the OwnTracks app on the owner's phone posts
// fixes and region events to this extension's address, signed in with a
// user and password made for it alone. It reads OwnTracks' format into
// fixes and transitions for the core, which keeps where the owner is; and
// it answers with the owner's saved places as OwnTracks regions when they
// changed, so the phone notices arrivals by itself. Setup makes the login
// and a link that opens OwnTracks with everything filled in.

import { type Extension, type Fix, type Json, type Transition } from "../sdk";

interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
}

interface State {
  user: string;
  password: string;
  made_at: number;
  /** The places the phone was last sent, so they go again only when they change. */
  regions: string;
}

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

/** One OwnTracks waypoint. An impossible latitude removes the region on the phone. */
const waypoint = (p: Place, tst: number) => ({
  _type: "waypoint",
  desc: p.name.replace(/:/g, " "),
  rid: p.id,
  lat: p.lat,
  lon: p.lon,
  rad: Math.round(p.radius_m),
  tst,
});

const hashOf = (all: Place[]) => all.map((p) => `${p.id}|${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}|${p.radius_m}`).join(";");

const placesOf = (data: Json | undefined): Place[] => {
  const ps = data && typeof data === "object" && !Array.isArray(data) ? (data as { places?: unknown }).places : null;
  return Array.isArray(ps) ? (ps as Place[]) : [];
};

/** Reads one OwnTracks post: a location is a fix, a transition is a region event with its fix. Anything else is left alone. */
export function readPost(body: unknown): { fixes: Fix[]; transitions: Transition[] } {
  const out = { fixes: [] as Fix[], transitions: [] as Transition[] };
  if (!body || typeof body !== "object") return out;
  const b = body as Record<string, unknown>;
  const lat = num(b.lat);
  const lon = num(b.lon);
  const tst = num(b.tst);
  if (lat == null || lon == null || tst == null) return out;
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
  if (b._type === "location") out.fixes.push(fix);
  else if (b._type === "transition" && (b.event === "enter" || b.event === "leave") && typeof b.rid === "string")
    out.transitions.push({ event: b.event, place: b.rid, fix });
  return out;
}

const same = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

const ext: Extension = {
  manifest: {
    id: "owntracks",
    name: "OwnTracks",
    version: "1.0.0",
    about: "Where you are, from the OwnTracks app on your phone, with your saved places as its regions. Light on the battery.",
    provides: ["location"],
    hosts: [],
    receives: {},
  },
  async setup(ctx) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const password = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const places = placesOf(ctx.data);
    const tst = Math.floor(ctx.now / 1000);
    const state: State = { user: "atlas", password, made_at: ctx.now, regions: hashOf(places) };
    const config = {
      _type: "configuration",
      mode: 3,
      url: ctx.address,
      auth: true,
      username: state.user,
      password,
      deviceId: "phone",
      tid: "me",
      monitoring: 1,
      locatorDisplacement: 200,
      locatorInterval: 300,
      extendedData: true,
      cmd: true,
      remoteConfiguration: true,
      allowRemoteLocation: true,
      waypoints: places.map((p) => waypoint(p, tst)),
    };
    const json = new TextEncoder().encode(JSON.stringify(config));
    let s = "";
    for (const b of json) s += String.fromCharCode(b);
    return {
      text: "Open this link on your iPhone (or scan the QR code with its camera) and OwnTracks fills everything in. Then allow location Always. Setting up again makes a new password, and the old setup stops working.",
      link: `owntracks:///config?inline=${encodeURIComponent(btoa(s))}`,
      fields: [
        { label: "Address", value: ctx.address ?? "" },
        { label: "User", value: state.user },
        { label: "Password", value: password },
      ],
      state: state as unknown as Json,
    };
  },
  async receive(ctx, req) {
    const st = ctx.state as unknown as State | null;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec((req.headers.authorization ?? "").trim());
    let given = "";
    try {
      given = m ? atob(m[1]!) : "";
    } catch {
      given = "";
    }
    if (!st || !given || !same(given, `${st.user}:${st.password}`)) {
      return {
        reply: {
          status: 401,
          json: { error: "OwnTracks' user or password is wrong. Set it up again in Atlas." },
          headers: { "www-authenticate": 'Basic realm="Atlas"' },
        },
      };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(req.body);
    } catch {
      return { reply: { status: 400, json: { error: "That isn't JSON." } } };
    }
    const read = readPost(body);
    // The saved places as regions, when they changed since the phone was last sent them (removed ones with an impossible latitude).
    const places = placesOf(ctx.data);
    const hash = hashOf(places);
    if (hash === st.regions) return { ...read, reply: { json: [] } };
    const sent = new Set(places.map((p) => p.id));
    const gone = st.regions
      .split(";")
      .filter(Boolean)
      .map((x) => x.split("|"))
      .filter(([id]) => id && !sent.has(id))
      .map(([id, name]) => ({ id: id!, name: name ?? "", lat: 91, lon: 0, radius_m: 0 }));
    const tst = Math.floor(ctx.now / 1000);
    return {
      ...read,
      reply: {
        json: [
          {
            _type: "cmd",
            action: "setWaypoints",
            waypoints: { _type: "waypoints", waypoints: [...places.map((p) => waypoint(p, tst)), ...gone.map((p) => waypoint(p, tst))] },
          },
        ],
      },
      state: { ...st, regions: hash } as unknown as Json,
    };
  },
};

export default ext;
