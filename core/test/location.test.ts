import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { here, metres, observe, ownTracksAnswer, ownTracksConfig, ownTracksLink, readOwnTracks, type Observation } from "../src/location";
import { migrate, type Sql } from "../src/store/db";
import { createRecord, forgetRecord } from "../src/store/records";
import { secretValues } from "../src/store/settings";
import { env, fakeCalendar, fakeEmbedder } from "./helpers";
import { connect, inOwner } from "./owner";

const GYM = { lat: 28.6024, lon: -81.2001 };
const STORE = { lat: 28.59, lon: -81.215 };
const T0 = Date.UTC(2026, 9, 22, 17, 0);

/** A point `m` metres north of `p`. */
const north = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 111_195, lon: p.lon });

const fix = (p: { lat: number; lon: number }, at: number, acc = 10): Observation => ({ kind: "fix", fix: { ...p, acc, at } });

async function inFresh<T>(name: string, fn: (sql: Sql) => T): Promise<T> {
  return runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(name)), async (_a, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

describe("what OwnTracks sends", () => {
  it("reads a location, with battery, connection, speed and motion, and a region event by its id", () => {
    const [loc] = readOwnTracks({
      _type: "location",
      lat: 28.6,
      lon: -81.2,
      tst: 1_761_152_400,
      acc: 12,
      batt: 64,
      bs: 1,
      conn: "m",
      vel: 30,
      motionactivities: ["automotive"],
      tid: "me",
    });
    expect(loc).toEqual({
      kind: "fix",
      fix: {
        lat: 28.6,
        lon: -81.2,
        acc: 12,
        at: 1_761_152_400_000,
        batt: 64,
        charging: false,
        conn: "mobile",
        speed: 30,
        motion: ["automotive"],
      },
    });
    const [tr] = readOwnTracks({
      _type: "transition",
      event: "leave",
      rid: "rec_1",
      desc: "Gym",
      lat: 28.6,
      lon: -81.2,
      tst: 1,
      acc: 5,
      wtst: 1,
    });
    expect(tr).toMatchObject({ kind: "region", event: "leave", rid: "rec_1" });
    expect(readOwnTracks({ _type: "waypoints", waypoints: [] })).toEqual([]);
    expect(readOwnTracks({ _type: "location", lat: "x" })).toEqual([]);
    expect(readOwnTracks(null)).toEqual([]);
  });
});

describe("arriving and leaving", () => {
  it("arrives once and leaves once, with how long you stayed, whether the phone or a fix says so first", async () => {
    await inFresh("loc-machine", (sql) => {
      const gym = createRecord(sql, { type: "place", name: "Gym", fields: { ...GYM, radius_m: 100 }, source: { via: "chat" } });
      expect(observe(sql, fix(north(GYM, 3_000), T0))).toEqual([
        expect.objectContaining({ event: "moved", near: { name: "Gym", m: 3000 } }),
      ]);
      // The phone's region event, then a fix inside: one arrival.
      expect(observe(sql, { kind: "region", event: "enter", rid: gym.id, fix: { ...north(GYM, 40), acc: 10, at: T0 + 600_000 } })).toEqual([
        expect.objectContaining({ event: "arrived", place: { id: gym.id, name: "Gym" } }),
      ]);
      expect(observe(sql, fix(north(GYM, 20), T0 + 700_000))).toEqual([]);
      // A jumpy fix just past the radius isn't leaving.
      expect(observe(sql, fix(north(GYM, 140), T0 + 800_000, 80))).toEqual([]);
      // Leaving, by a fix well outside: once, with the time there.
      const [left] = observe(sql, fix(north(GYM, 400), T0 + 600_000 + 70 * 60_000));
      expect(left).toMatchObject({ event: "left", place: { name: "Gym" }, stayed_ms: 70 * 60_000 });
      // The phone's own leave event after that changes nothing.
      expect(
        observe(sql, { kind: "region", event: "leave", rid: gym.id, fix: { ...north(GYM, 500), acc: 10, at: T0 + 75 * 60_000 } }),
      ).toEqual([]);
      expect(here(sql).left).toMatchObject({ name: "Gym" });
    });
  });

  it("logs a move only after a real one, and ignores a fix older than the one it has", async () => {
    await inFresh("loc-moves", (sql) => {
      createRecord(sql, { type: "place", name: "Gym", fields: GYM, source: { via: "chat" } });
      const start = north(GYM, 5_000);
      expect(observe(sql, fix(start, T0))).toHaveLength(1);
      expect(observe(sql, fix(north(start, 400), T0 + 60_000))).toEqual([]);
      expect(observe(sql, fix(north(start, 900), T0 + 120_000))).toEqual([]);
      expect(observe(sql, fix(north(start, 1_100), T0 + 180_000))).toEqual([expect.objectContaining({ event: "moved" })]);
      // OwnTracks sends what it queued offline late: an older fix doesn't move Atlas back.
      expect(observe(sql, fix(GYM, T0 + 30_000))).toEqual([]);
      expect(here(sql).fix?.at).toBe(T0 + 180_000);
      // A rough fix doesn't count as a move.
      expect(observe(sql, fix(north(start, 4_000), T0 + 240_000, 900))).toEqual([]);
    });
  });

  it("forgets being at a place that was deleted, without saying you left", async () => {
    await inFresh("loc-deleted", (sql) => {
      const gym = createRecord(sql, { type: "place", name: "Gym", fields: GYM, source: { via: "chat" } });
      observe(sql, fix(GYM, T0));
      expect(here(sql).place?.name).toBe("Gym");
      forgetRecord(sql, gym.id, { via: "owner" });
      expect(observe(sql, fix(north(GYM, 30), T0 + 60_000)).filter((b) => b.event !== "moved")).toEqual([]);
      expect(here(sql).place).toBeNull();
    });
  });
});

describe("regions and setup for the phone", () => {
  it("sends saved places as regions once, again when they change, and removes deleted ones", async () => {
    await inFresh("loc-regions", (sql) => {
      expect(ownTracksAnswer(sql)).toEqual([]);
      const gym = createRecord(sql, { type: "place", name: "Gym", fields: GYM, source: { via: "chat" } });
      createRecord(sql, { type: "place", name: "No pin yet", fields: { address: "1 Main St" }, source: { via: "chat" } });
      const [cmd] = ownTracksAnswer(sql) as Array<{ action: string; waypoints: { waypoints: Array<Record<string, unknown>> } }>;
      expect(cmd!.action).toBe("setWaypoints");
      expect(cmd!.waypoints.waypoints).toEqual([
        expect.objectContaining({ _type: "waypoint", desc: "Gym", rid: gym.id, rad: 120, ...GYM }),
      ]);
      expect(ownTracksAnswer(sql)).toEqual([]);
      const store = createRecord(sql, { type: "organization", name: "Publix: Oviedo", fields: STORE, source: { via: "chat" } });
      const [again] = ownTracksAnswer(sql) as Array<{ waypoints: { waypoints: Array<{ rid: string; desc: string }> } }>;
      expect(again!.waypoints.waypoints.map((w) => w.rid).sort()).toEqual([gym.id, store.id].sort());
      expect(again!.waypoints.waypoints.find((w) => w.rid === store.id)!.desc).toBe("Publix  Oviedo");
      forgetRecord(sql, gym.id, { via: "owner" });
      const [gone] = ownTracksAnswer(sql) as Array<{ waypoints: { waypoints: Array<{ rid: string; lat: number }> } }>;
      expect(gone!.waypoints.waypoints.find((w) => w.rid === gym.id)!.lat).toBe(91);
    });
  });

  it("makes a setup link OwnTracks reads: HTTP mode to this Atlas, its own login, remote commands on", async () => {
    await inFresh("loc-config", (sql) => {
      const config = ownTracksConfig(sql, "https://atlas.example", { user: "atlas", password: "pw-123456789", made_at: 0 });
      expect(config).toMatchObject({ _type: "configuration", mode: 3, url: "https://atlas.example/owntracks", auth: true, cmd: true });
      const link = ownTracksLink(config);
      expect(link.startsWith("owntracks:///config?inline=")).toBe(true);
      const back = JSON.parse(atob(decodeURIComponent(link.split("inline=")[1]!)));
      expect(back).toEqual(config);
    });
  });

  it("measures distances on the earth", () => {
    expect(Math.round(metres(GYM, north(GYM, 1_000)))).toBe(1_000);
  });
});

// --- through the Worker -------------------------------------------------------------------------------

const post = (body: unknown, auth?: string) =>
  SELF.fetch("https://atlas.test/owntracks", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;
const location = (p: { lat: number; lon: number }, at: number) => ({
  _type: "location",
  ...p,
  tst: Math.floor(at / 1000),
  acc: 10,
  tid: "me",
});

describe("OwnTracks through the Worker", () => {
  beforeEach(async () => {
    seams.calendar = fakeCalendar([]);
    seams.embed = fakeEmbedder();
    await inOwner((_a, sql) => {
      sql.exec(`DELETE FROM secrets WHERE name = 'owntracks'`);
      sql.exec(`DELETE FROM state WHERE key = 'location'`);
      sql.exec(`DELETE FROM settings WHERE key = 'location'`);
      sql.exec(`DELETE FROM records WHERE type = 'place'`);
      sql.exec(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('origin', '"https://atlas.test"', 0)`);
    });
  });
  afterEach(() => {
    seams.calendar = undefined;
    seams.embed = undefined;
  });

  it("is set up from Settings, takes only its own login, logs arrivals, and sends the regions", async () => {
    const s = await connect();
    // Before setup, nothing gets in.
    expect((await post(location(GYM, T0))).status).toBe(401);
    s.send({ type: "atlas.location.setup" });
    const setup = await s.next("atlas.location.setup");
    expect(setup.url).toBe("https://atlas.test/owntracks");
    expect(setup.link).toMatch(/^owntracks:\/\/\/config\?inline=/);
    const auth = basic(setup.user, setup.password);
    // OwnTracks' password never leaves in a message.
    expect(await inOwner((_a, sql) => secretValues(sql))).toContain(setup.password);

    const wrong = await post(location(GYM, T0), basic(setup.user, "nope"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Basic");
    const view = await s.next("atlas.view", (m) => m.view.location.set_up && m.view.location.refused != null);
    expect(view.view.location).toMatchObject({ set_up: true, refused: { n: expect.any(Number) } });

    const gym = await inOwner((_a, sql) => createRecord(sql, { type: "place", name: "Gym", fields: GYM, source: { via: "chat" } }));
    const res = await post(location(GYM, T0), auth);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Array<{ action: string }>;
    expect(answer[0]?.action).toBe("setWaypoints");
    expect(await (await post(location(north(GYM, 10), T0 + 60_000), auth)).json()).toEqual([]);

    const rows = await inOwner((_a, sql) =>
      sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'sense' AND json_extract(body, '$.place.id') = ? ORDER BY seq`, gym.id)
        .toArray()
        .map((r) => JSON.parse(r.body)),
    );
    expect(rows).toEqual([expect.objectContaining({ event: "arrived", place: { id: gym.id, name: "Gym" } })]);
    const seen = await s.next("atlas.view", (m) => m.view.location.place != null);
    expect(seen.view.location).toMatchObject({ place: { name: "Gym" }, fix: { acc: 10 }, pins: 1 });

    // Setting it up again makes a new password; the old one stops working.
    s.send({ type: "atlas.location.setup" });
    const again = await s.next("atlas.location.setup");
    expect(again.password).not.toBe(setup.password);
    expect((await post(location(GYM, T0 + 120_000), auth)).status).toBe(401);
  });

  it("drops what OwnTracks sends while location is off, and says so in the log", async () => {
    const s = await connect();
    const from = await inOwner((_a, sql) => sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM log`).one().seq);
    s.send({ type: "atlas.location.setup" });
    const setup = await s.next("atlas.location.setup");
    const auth = basic(setup.user, setup.password);
    await inOwner((_a, sql) => createRecord(sql, { type: "place", name: "Gym", fields: GYM, source: { via: "chat" } }));
    await post(location(GYM, T0), auth);
    s.send({ type: "atlas.settings.update", patch: { location: { on: false } } });
    await s.next("atlas.view", (m) => m.view.settings.location.on === false);
    expect(await inOwner((_a, sql) => here(sql))).toMatchObject({ fix: null, place: null });
    expect((await post(location(north(GYM, 5_000), T0 + 60_000), auth)).status).toBe(200);
    expect(await inOwner((_a, sql) => here(sql).fix)).toBeNull();
    s.send({ type: "atlas.settings.update", patch: { location: { on: true } } });
    // An older view (from before it was turned off) also says on, so wait for the row itself.
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "sense" && r.body.event === "on"));
    const events = await inOwner((_a, sql) =>
      sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'sense' AND seq > ? ORDER BY seq`, from)
        .toArray()
        .map((r) => JSON.parse(r.body).event as string),
    );
    expect(events).toEqual(["arrived", "off", "on"]);
  });

  it("refuses what isn't JSON, and posts that are too big", async () => {
    const s = await connect();
    s.send({ type: "atlas.location.setup" });
    const setup = await s.next("atlas.location.setup");
    const auth = basic(setup.user, setup.password);
    const bad = await SELF.fetch("https://atlas.test/owntracks", { method: "POST", headers: { authorization: auth }, body: "{nope" });
    expect(bad.status).toBe(400);
    const big = await SELF.fetch("https://atlas.test/owntracks", {
      method: "POST",
      headers: { authorization: auth },
      body: "x".repeat(70_000),
    });
    expect(big.status).toBe(413);
  });
});
