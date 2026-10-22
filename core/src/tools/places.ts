// Places, routes, weather and errands (VISION §10, §19.1). Looking things up
// on a map leaves Atlas, so each call goes through the outbox's look with a
// receipt; pinning a place and keeping an errand change the owner's own
// things, so Atlas does them, shows a receipt, and offers Undo (§12.1).

import { z } from "zod";
import { here, homePin, metres, type Pin, pinOf, pins } from "../location";
import { distance as say, unitsFor, sky, temp, type Units } from "../weather";
import { KINDS, minutes, type Found, type Point, PLACE_KINDS, type Travel } from "../maps";
import { createItem, finish, getItem, upcoming } from "../store/agenda";
import { correctRecord, createRecord, findRecords, getRecord, type AtlasRecord } from "../store/records";
import { get as getRow } from "../store/log";
import { clockLocal, isoLocal, parseWhen, shortLocal } from "../time";
import { defineTool, fail, type ToolContext } from "./types";

/** An errand with no deadline sits on the clock here, past anything that's due. */
export const NO_DEADLINE = 8_640_000_000_000_000;

const unitsOf = (ctx: ToolContext): Units => unitsFor(ctx.settings.units, ctx.tz);

/** A saved place by id or name (any case), with or without a pin. */
function savedPlace(ctx: ToolContext, ref: string): AtlasRecord | null {
  const r = getRecord(ctx.sql, ref);
  if (r && r.state === "active" && (r.type === "place" || r.type === "organization")) return r;
  return findRecords(ctx.sql, "place", ref)[0] ?? findRecords(ctx.sql, "organization", ref)[0] ?? null;
}

type Where = { ok: true; point: Point; name: string; pin?: Pin } | { ok: false; error: string };

/** Where the owner is, when Atlas knows. */
function hereNow(ctx: ToolContext): Where {
  if (!ctx.settings.location.on)
    return { ok: false, error: "Location is off, so Atlas doesn't know where the owner is. Ask them, or use a saved place or an address." };
  const h = here(ctx.sql);
  if (!h.fix)
    return {
      ok: false,
      error:
        "No location has come in yet (OwnTracks isn't set up in Settings → Devices, or hasn't reported). Ask where they are, or use a saved place or an address.",
    };
  return { ok: true, point: { lat: h.fix.lat, lon: h.fix.lon }, name: h.place?.name ?? "where you are" };
}

/** "here", "home", a saved place (by name or id), or an address, as a point. An address is looked up near the owner. */
async function resolve(ctx: ToolContext, ref: string): Promise<Where> {
  const t = ref.trim();
  if (/^(here|me|my location|where i am|current location)$/i.test(t)) return hereNow(ctx);
  if (/^home$/i.test(t)) {
    const h = homePin(ctx.sql);
    if (h) return { ok: true, point: h, name: "Home", pin: h };
  }
  const saved = savedPlace(ctx, t);
  const pin = saved ? pinOf(saved) : null;
  if (pin) return { ok: true, point: pin, name: pin.name, pin };
  if (!ctx.maps) return { ok: false, error: "Maps aren't reachable from this run." };
  const address = saved && typeof saved.fields.address === "string" ? saved.fields.address : t;
  const near = hereNow(ctx);
  const out = await ctx.maps.geocode(address, { run_id: ctx.run_id, ...(near.ok ? { near: near.point } : {}) });
  if (!out.ok) return { ok: false, error: out.error };
  const best = out.value[0];
  if (!best) {
    return {
      ok: false,
      error: /^home$/i.test(t)
        ? "Home isn't a saved place with a pin yet. Ask for the address, then place_pin it."
        : `OpenStreetMap found nothing for "${address}". Try a fuller address, or the place's name and town.`,
    };
  }
  return { ok: true, point: best, name: saved?.name ?? best.name };
}

export const placePin = defineTool({
  name: "place_pin",
  kind: "change_own",
  description: [
    "Pin a saved place on the map, so Atlas notices when the owner arrives or leaves, and can route to it.",
    "Use at: here when the owner says they're there now ('this is my gym'), or at: address with its address (found with OpenStreetMap, and kept).",
    "It makes the place if it isn't saved yet. Name the owner's home 'Home'. The owner sees a 'Pinned' chip with Undo.",
  ].join(" "),
  input: z.object({
    place: z.string().min(1).max(120).describe("The saved place's name or id, or the name for a new one: 'Gym', 'Home', 'Dr. Patel'."),
    at: z.enum(["here", "address"]),
    address: z.string().max(300).optional().describe("With at: address, the address. Leave out to use the address the place already has."),
    radius_m: z
      .number()
      .int()
      .min(30)
      .max(2000)
      .optional()
      .describe("How close counts as being there, in metres. About 120 by default; bigger for a campus or a park."),
  }),
  async run(input, ctx) {
    const existing = savedPlace(ctx, input.place);
    let point: Point;
    let address = input.address ?? (typeof existing?.fields.address === "string" ? existing.fields.address : undefined);
    if (input.at === "here") {
      const h = hereNow(ctx);
      if (!h.ok) return fail(h.error);
      if ((here(ctx.sql).fix?.acc ?? 0) > 150) {
        return fail(
          `The phone's last fix is only accurate to ${Math.round(here(ctx.sql).fix!.acc)} m, too rough to pin a place. Try again in a minute, or give the address.`,
        );
      }
      point = h.point;
    } else {
      if (!address) return fail(`${input.place} has no address yet. Ask the owner for it.`);
      if (!ctx.maps) return fail("Maps aren't reachable from this run.");
      const near = hereNow(ctx);
      const out = await ctx.maps.geocode(address, { run_id: ctx.run_id, ...(near.ok ? { near: near.point } : {}) });
      if (!out.ok) return fail(out.error);
      const best = out.value[0];
      if (!best) return fail(`OpenStreetMap found nothing for "${address}". Ask for a fuller address.`);
      point = best;
      address = best.address || address;
    }
    const fields = {
      lat: Math.round(point.lat * 1e6) / 1e6,
      lon: Math.round(point.lon * 1e6) / 1e6,
      ...(input.radius_m ? { radius_m: input.radius_m } : {}),
      ...(address ? { address } : {}),
      ...(input.place.trim().toLowerCase() === "home" ? { is_home: true } : {}),
    };
    const source = { via: ctx.via, run_id: ctx.run_id, ...(ctx.source_log_id ? { log_id: ctx.source_log_id } : {}) };
    if (existing) {
      const r = correctRecord(ctx.sql, existing.id, { fields }, "pinned on the map", source);
      return {
        ok: true,
        output: { id: r.id, pinned: r.name, ...(address ? { address } : {}) },
        receipt: { text: `Pinned · ${r.name}`, undo: { kind: "record.revert", id: r.id, history: r.history_seq } },
      };
    }
    const r = createRecord(ctx.sql, {
      type: "place",
      name: input.place.trim(),
      fields: { fact: `${input.place.trim()} is a place the owner goes.`, ...fields },
      source,
    });
    return {
      ok: true,
      output: { id: r.id, pinned: r.name, made: true },
      receipt: { text: `Pinned · ${r.name}`, undo: { kind: "record.forget", id: r.id } },
    };
  },
});

export const placeFind = defineTool({
  name: "place_find",
  kind: "look",
  status: "Looking at the map",
  timeoutMs: 45_000,
  description: [
    "Find places on the map: a kind of place (a grocery store, a pharmacy) or one by name, near somewhere, or along the way to somewhere.",
    "With on_the_way_to (often 'home'), it routes there from `near` and finds places just off the route, with how many minutes off the way each one is: that's how you suggest an errand stop.",
    "Results come from OpenStreetMap (or Mapbox when the owner picked it); opening hours are often missing, so don't promise a place is open unless the result says so.",
  ].join(" "),
  input: z.object({
    kind: z
      .enum(PLACE_KINDS)
      .optional()
      .describe(`A kind of place: ${PLACE_KINDS.join(", ")}.`),
    name: z.string().max(80).optional().describe("A name to look for instead, like 'Publix' or 'Trader Joe's'."),
    near: z.string().max(200).default("here").describe("'here', 'home', a saved place, or an address."),
    on_the_way_to: z.string().max(200).optional().describe("'home', a saved place or an address, to find places along the way there."),
    within_m: z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .optional()
      .describe("How far counts: from `near`, or off the route. About 1500 near, 600 along a route."),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async run(input, ctx) {
    if (!ctx.maps) return fail("Maps aren't reachable from this run.");
    if (!input.kind && !input.name) return fail("Give a kind of place or a name.");
    const from = await resolve(ctx, input.near);
    if (!from.ok) return fail(from.error);
    const u = unitsOf(ctx);
    const what = input.kind ? KINDS[input.kind].words : input.name!;
    if (!input.on_the_way_to) {
      const out = await ctx.maps.nearby(
        {
          ...(input.kind ? { kind: input.kind } : { name: input.name }),
          near: from.point,
          within: input.within_m ?? 1_500,
          limit: input.limit,
        },
        { run_id: ctx.run_id, label: `${what} near ${from.name}` },
      );
      if (!out.ok) return fail(out.error);
      return { ok: true, output: { near: from.name, places: out.value.map((p) => found(p, from.point, u)) } };
    }
    const to = await resolve(ctx, input.on_the_way_to);
    if (!to.ok) return fail(to.error);
    const direct = await ctx.maps.route([from.point, to.point], "drive", { run_id: ctx.run_id, label: `${from.name} to ${to.name}` });
    if (!direct.ok) return fail(direct.error);
    const out = await ctx.maps.nearby(
      {
        ...(input.kind ? { kind: input.kind } : { name: input.name }),
        near: from.point,
        along: direct.value.line,
        within: input.within_m ?? 600,
        limit: 8,
      },
      { run_id: ctx.run_id, label: `${what} on the way from ${from.name} to ${to.name}` },
    );
    if (!out.ok) return fail(out.error);
    // The real detour for the closest few: the route through each, less the direct one.
    const best = out.value.slice(0, 3);
    const detours: Array<Found & { detour_min: number }> = [];
    for (const p of best) {
      const via = await ctx.maps.route([from.point, p, to.point], "drive", {
        run_id: ctx.run_id,
        label: `${from.name} to ${to.name} by ${p.name}`,
      });
      if (via.ok) detours.push({ ...p, detour_min: Math.max(0, Math.round((via.value.s - direct.value.s) / 60)) });
    }
    detours.sort((a, b) => a.detour_min - b.detour_min);
    return {
      ok: true,
      output: {
        from: from.name,
        to: to.name,
        trip: `${minutes(direct.value.s)} by car${direct.value.traffic ? " with traffic" : ""}`,
        places: (detours.length ? detours : out.value.slice(0, input.limit)).slice(0, input.limit).map((p) => found(p, from.point, u)),
      },
    };
  },
});

function found(p: Found, from: Point, u: Units) {
  return {
    name: p.name,
    ...(p.address ? { address: p.address } : {}),
    away: say(metres(from, p), u),
    ...(p.detour_min != null ? { minutes_off_the_way: p.detour_min } : {}),
    ...(p.hours ? { hours: p.hours } : {}),
  };
}

export const routeTool = defineTool({
  name: "route",
  kind: "look",
  status: "Checking the route",
  description: [
    "How long it takes to get somewhere, and the route: from 'here' by default, by car unless the owner walks or bikes.",
    "The situation already has the travel time to the next event with a place; use this for anything else. OpenStreetMap has no live traffic, so say travel times are typical; Mapbox's include traffic.",
    "show: true puts the route on a map on the stage.",
  ].join(" "),
  input: z.object({
    to: z.string().min(1).max(200).describe("'home', a saved place, or an address."),
    from: z.string().max(200).default("here"),
    by: z.enum(["drive", "walk", "bike"]).default("drive"),
    show: z.boolean().default(false),
  }),
  async run(input, ctx) {
    if (!ctx.maps) return fail("Maps aren't reachable from this run.");
    const a = await resolve(ctx, input.from);
    if (!a.ok) return fail(a.error);
    const b = await resolve(ctx, input.to);
    if (!b.ok) return fail(b.error);
    const r = await ctx.maps.route([a.point, b.point], input.by as Travel, { run_id: ctx.run_id, label: `${a.name} to ${b.name}` });
    if (!r.ok) return fail(r.error);
    const u = unitsOf(ctx);
    const view = {
      kind: "map" as const,
      title: `${a.name} to ${b.name}`,
      markers: [
        { name: a.name, lat: a.point.lat, lon: a.point.lon },
        { name: b.name, lat: b.point.lat, lon: b.point.lon },
      ],
      route: { line: r.value.line, s: Math.round(r.value.s), m: Math.round(r.value.m), by: input.by, traffic: r.value.traffic },
    };
    return {
      ok: true,
      output: {
        from: a.name,
        to: b.name,
        takes: `${minutes(r.value.s)}${r.value.traffic ? " with traffic" : " (typical, no live traffic)"}`,
        distance: say(r.value.m, u),
        arrive_if_you_leave_now: clockLocal(new Date(ctx.now.getTime() + r.value.s * 1000), ctx.tz),
      },
      ...(input.show ? { receipt: { text: `Route · ${a.name} to ${b.name} · ${minutes(r.value.s)}`, view } } : {}),
    };
  },
});

export const weatherTool = defineTool({
  name: "weather",
  kind: "look",
  status: "Checking the weather",
  description: [
    "The forecast from Open-Meteo for the next seven days, for a rough area around a place ('here' by default).",
    "Today's weather near the owner is already in the situation; use this for other days or other places. show: true (near here only) puts the weather on the stage.",
  ].join(" "),
  input: z.object({ near: z.string().max(200).default("here"), show: z.boolean().default(false) }),
  async run(input, ctx) {
    if (!ctx.maps) return fail("The weather isn't reachable from this run.");
    const at = await resolve(ctx, input.near);
    if (!at.ok) return fail(at.error);
    const w = await ctx.maps.weather(at.point, { run_id: ctx.run_id, label: `the weather near ${at.name}` });
    if (!w.ok) return fail(w.error);
    const u = unitsOf(ctx);
    return {
      ok: true,
      output: {
        near: at.name,
        now: `${temp(w.value.now.temp_c, u)}, ${sky(w.value.now.code)}`,
        next_hours: w.value.hours
          .filter((_, i) => i % 3 === 0)
          .map((h) => `${clockLocal(new Date(h.t), ctx.tz)}: ${temp(h.temp_c, u)}, ${sky(h.code)}${h.pop >= 20 ? `, ${h.pop}% rain` : ""}`),
        days: w.value.days.map(
          (d) => `${d.date}: ${temp(d.min_c, u)} to ${temp(d.max_c, u)}, ${sky(d.code)}${d.pop >= 20 ? `, ${d.pop}% rain` : ""}`,
        ),
      },
      // The weather view is the weather near the owner, from the situation.
      ...(input.show && /^here$/i.test(input.near.trim())
        ? { receipt: { text: "Weather · near you", view: { kind: "weather" as const } } }
        : {}),
    };
  },
});

// --- errands ---------------------------------------------------------------------------------------

export const errandAdd = defineTool({
  name: "errand_add",
  kind: "change_own",
  description: [
    "Keep an errand: something the owner needs to do or get when they're near the right kind of place ('I need oat milk', 'drop off the package').",
    "Atlas notices when they leave somewhere or pass by, and suggests a stop on the way. Use it whenever the owner mentions something to pick up or drop off without a time; with a time, use reminder_create instead.",
    "The owner sees an 'Errand' chip with Undo, and the errand in Agenda.",
  ].join(" "),
  input: z.object({
    what: z.string().min(1).max(200).describe("The errand in a few words: 'Oat milk'."),
    kind: z
      .enum(PLACE_KINDS)
      .optional()
      .describe(`The kind of place it can be done at: ${PLACE_KINDS.join(", ")}.`),
    place: z.string().max(120).optional().describe("A particular saved place or store, when it has to be that one."),
    by: z.string().optional().describe("A deadline, if there is one, as a local date-time YYYY-MM-DDTHH:mm."),
  }),
  async run(input, ctx) {
    const deadline = input.by ? parseWhen(input.by, ctx.tz) : null;
    if (input.by && !deadline) return fail(`Couldn't read the deadline "${input.by}". Use YYYY-MM-DDTHH:mm.`);
    const said = ctx.source_log_id ? getRow(ctx.sql, ctx.source_log_id) : null;
    const item = createItem(ctx.sql, {
      kind: "errand",
      title: input.what,
      due_at: deadline?.getTime() ?? NO_DEADLINE,
      source: {
        run_id: ctx.run_id,
        via: "chat",
        ...(said ? { log_id: said.id } : {}),
        detail: {
          ...(input.kind ? { place_kind: input.kind } : {}),
          ...(input.place ? { place: input.place } : {}),
          ...(said ? { said: String(said.body.text ?? "").slice(0, 300) } : {}),
        },
      },
    });
    if (deadline) await ctx.clock.schedule(item);
    return {
      ok: true,
      output: {
        id: item.id,
        errand: item.title,
        ...(input.kind ? { at: KINDS[input.kind].words } : {}),
        ...(deadline ? { by: isoLocal(deadline, ctx.tz) } : {}),
      },
      receipt: {
        text: `Errand · ${item.title}${deadline ? ` · by ${shortLocal(deadline, ctx.tz)}` : ""}`,
        undo: { kind: "reminder.cancel", id: item.id },
      },
    };
  },
});

export const errandDone = defineTool({
  name: "errand_done",
  kind: "change_own",
  description:
    "Mark an errand done (the owner got it, or doesn't need it any more), so Atlas stops suggesting it. Its id is in the open errands in your context.",
  input: z.object({ id: z.string().max(64), why: z.enum(["done", "not needed"]).default("done") }),
  async run(input, ctx) {
    const item = getItem(ctx.sql, input.id);
    if (!item || item.kind !== "errand") return fail(`There's no errand with id ${input.id}.`);
    if (item.state !== "scheduled") return fail(`"${item.title}" isn't open any more.`);
    await ctx.clock.unschedule(item);
    finish(ctx.sql, item.id, input.why === "done" ? "done" : "cancelled", ctx.run_id, { by: "owner" });
    return { ok: true, output: { done: item.title }, receipt: { text: `${input.why === "done" ? "Done" : "Dropped"} · ${item.title}` } };
  },
});

/** Open errands, oldest first. */
export const openErrands = (ctx: Pick<ToolContext, "sql">) =>
  upcoming(ctx.sql, 200)
    .filter((i) => i.kind === "errand" && i.state === "scheduled")
    .sort((a, b) => a.created_at - b.created_at);

export const placeTools = [placePin, placeFind, routeTool, weatherTool, errandAdd, errandDone];
export const placeLooks = [placeFind, routeTool, weatherTool];
export { pins };
