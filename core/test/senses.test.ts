// M4's senses end to end: the gym-to-store moment, events that don't
// matter, reactions, rhythm moments, and the situation in the prompt. Maps,
// weather, decide and the brain are all fakes (CLAUDE.md).

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import type { Decider } from "../src/brains/decide";
import { parse, type Sql } from "../src/store/db";
import { createRecord } from "../src/store/records";
import { readSettings } from "../src/store/settings";
import { fetchWeather, whatMatters } from "../src/weather";
import { polyline, samples } from "../src/maps";
import { call, fakeCalendar, fakeEmbedder, say, SECRET } from "./helpers";
import { brain, connect, inOwner, turn, type Socket } from "./owner";

const GYM = { lat: 28.6024, lon: -81.2001 };
const HOME = { lat: 28.64, lon: -81.21 };
const STORE = { lat: 28.62, lon: -81.205 };
const north = (p: { lat: number; lon: number }, m: number) => ({ lat: p.lat + m / 111_195, lon: p.lon });

/** Fake OpenStreetMap and Open-Meteo, recording what was asked. */
function fakeWorld() {
  const asked: string[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${String(init.body)}` : ""}`);
    const ua = new Headers(init?.headers).get("user-agent") ?? "";
    if (!ua.startsWith("Atlas/")) return new Response("no user agent", { status: 403 });
    if (url.startsWith("https://api.open-meteo.com/")) {
      const t = Math.floor(Date.now() / 3_600_000) * 3600;
      const hours = Array.from({ length: 30 }, (_, i) => t + i * 3600);
      return Response.json({
        utc_offset_seconds: -14400,
        current: { temperature_2m: 27, apparent_temperature: 29, weather_code: 2, wind_speed_10m: 12 },
        hourly: {
          time: hours,
          temperature_2m: hours.map(() => 28),
          precipitation_probability: hours.map((_, i) => (i >= 3 && i <= 5 ? 70 : 5)),
          precipitation: hours.map((_, i) => (i >= 3 && i <= 5 ? 2 : 0)),
          weather_code: hours.map((_, i) => (i >= 3 && i <= 5 ? 63 : 2)),
          wind_speed_10m: hours.map(() => 10),
        },
        daily: {
          time: [t],
          weather_code: [63],
          temperature_2m_max: [31],
          temperature_2m_min: [22],
          precipitation_probability_max: [70],
          uv_index_max: [6],
        },
      });
    }
    if (url.startsWith("https://nominatim.openstreetmap.org/search")) {
      return Response.json([
        { lat: "28.555", lon: "-81.3", name: "Dr. Patel Dental", display_name: "Dr. Patel Dental, 1 Main St, Orlando" },
      ]);
    }
    if (url.startsWith("https://routing.openstreetmap.de/")) {
      const pts = url.split("/driving/")[1]!.split("?")[0]!.split(";");
      const line = pts.map((p) => p.split(",").map(Number) as [number, number]);
      // Through a third point costs four minutes more.
      return Response.json({
        code: "Ok",
        routes: [{ duration: pts.length > 2 ? 840 : 600, distance: 5_000, geometry: { coordinates: line } }],
      });
    }
    if (url.startsWith("https://overpass-api.de/")) {
      return Response.json({
        elements: [
          { type: "node", lat: STORE.lat, lon: STORE.lon, tags: { name: "Publix", shop: "supermarket", "addr:street": "Alafaya Trail" } },
          { type: "node", lat: 28.9, lon: -81.9, tags: { shop: "supermarket" } },
        ],
      });
    }
    return new Response("not faked", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, asked };
}

/** A fake decide role: an errand question is yes when `yes` says so; a reaction reads "thanks" or "stop" from the reply. */
function decider(o: { errand: number }): Decider & { asked: Array<Record<string, string>> } {
  const asked: Array<Record<string, string>> = [];
  return {
    model: "fake-decide",
    asked,
    async yesNo(state, questions) {
      asked.push(Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.instructions])));
      const out: Record<string, number> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id === "stop") out[id] = /"stop/i.test(state.split("The owner replied:")[1] ?? "") ? 0.95 : 0.05;
        else if (id === "thanks") out[id] = /thank/i.test(state.split("The owner replied:")[1] ?? "") ? 0.95 : 0.05;
        // Like Clef: an errand fits when they're leaving somewhere and heading on, not when they arrive.
        else if (q.instructions.includes("errand")) out[id] = /left|moved/.test(state.split("\n")[0]!) ? o.errand : 0.05;
        else out[id] = 0.01;
      }
      return out;
    },
  };
}

const post = (body: unknown, auth: string) =>
  SELF.fetch("https://atlas.test/owntracks", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });
const fixAt = (p: { lat: number; lon: number }, at = Date.now()) => ({
  _type: "location",
  ...p,
  tst: Math.floor(at / 1000),
  acc: 10,
  tid: "me",
});

async function rowsSince(seq: number, kind: string): Promise<Array<Record<string, unknown> & { run_id: string | null }>> {
  return inOwner((_a, sql) =>
    sql
      .exec<{ body: string; run_id: string | null }>(`SELECT body, run_id FROM log WHERE kind = ? AND seq > ? ORDER BY seq`, kind, seq)
      .toArray()
      .map((r) => ({ ...parse<Record<string, unknown>>(r.body, {}), run_id: r.run_id })),
  );
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const lastSeq = () => inOwner((_a, sql: Sql) => sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM log`).one().seq);

let world: ReturnType<typeof fakeWorld>;
let s: Socket;
let auth: string;

beforeEach(async () => {
  world = fakeWorld();
  seams.fetch = world.f;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM records WHERE type IN ('place', 'organization')`);
    sql.exec(`DELETE FROM state WHERE key IN ('location', 'situation', 'nudges')`);
    sql.exec(`DELETE FROM settings WHERE key IN ('location', 'speaking', 'maps')`);
    sql.exec(
      `UPDATE agenda SET state = 'cancelled' WHERE (kind = 'errand' OR (kind = 'rhythm' AND json_extract(source, '$.detail.moment') = 'leave')) AND state = 'scheduled'`,
    );
    createRecord(sql, { type: "place", name: "Gym", fields: { ...GYM, radius_m: 100 }, source: { via: "chat" } });
    createRecord(sql, { type: "place", name: "Home", fields: { ...HOME, is_home: true }, source: { via: "chat" } });
  });
  s = await connect();
  s.send({ type: "atlas.location.setup" });
  const setup = await s.next("atlas.location.setup");
  auth = `Basic ${btoa(`${setup.user}:${setup.password}`)}`;
});

afterEach(() => {
  seams.fetch = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.decide = undefined;
  seams.makeBrain = null;
});

describe("the gym-to-store moment", () => {
  it("keeps the errand, and leaving the gym brings a nudge about a store on the way home", async () => {
    const d = decider({ errand: 0.92 });
    seams.decide = d;
    const b = brain([
      call("errand_add", { what: "Oat milk", kind: "grocery" }),
      say("I'll keep an eye out."),
      // The wake run, after leaving the gym.
      call("place_find", { kind: "grocery", near: "here", on_the_way_to: "home" }),
      (req) => {
        const found = String(req.messages.at(-1)!.content);
        expect(found).toContain("Publix");
        expect(found).toContain('"minutes_off_the_way":4');
        return call("nudge", { text: "There's a Publix four minutes off your way home. Still need oat milk?" });
      },
      say("Nudged about the Publix."),
    ]);
    const t = await turn(s, "I need oat milk");
    expect(t.results[0]!.body.receipt).toMatchObject({ text: "Errand · Oat milk" });
    const agenda = await inOwner((_a, sql) =>
      sql.exec<{ title: string; state: string }>(`SELECT title, state FROM agenda WHERE kind = 'errand' AND state = 'scheduled'`).toArray(),
    );
    expect(agenda).toEqual([{ title: "Oat milk", state: "scheduled" }]);

    const from = await lastSeq();
    await post(fixAt(GYM, Date.now() - 50 * 60_000), auth);
    await post(fixAt(north(GYM, 600)), auth);
    const nudge = await waitFor("the nudge", async () =>
      (await rowsSince(from, "message.out")).find((r) => (r.nudge as { kind?: string } | undefined)?.kind === "errands"),
    );
    expect(nudge.text).toContain("Publix");
    const aware = await waitFor("the awareness row", async () => (await rowsSince(from, "awareness")).find((r) => r.step === "woke"));
    expect(aware).toMatchObject({ outcome: "nudged", event: expect.stringContaining("left Gym") });
    expect(aware.run_id).toBe(nudge.run_id);
    // Decide was asked about the errand, with the event and the situation.
    expect(Object.values(d.asked.at(-1)!).join(" ")).toContain("Oat milk");
    // The wake run had the note, the nudge tool and the map's tools.
    const wake = b.requests[2]!;
    expect(wake.messages.some((m) => m.role === "user" && String(m.content).includes("[Atlas's senses, not the owner]"))).toBe(true);
    expect(wake.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["nudge", "place_find", "route", "errand_done"]));
    expect(wake.system).toContain("Where: out, not at a saved place");
    expect(wake.system).toContain("Oat milk (at a grocery store)");
    // The map's calls left through the outbox, with Atlas's name, each with a receipt.
    expect(world.asked.some((a) => a.includes("overpass-api.de") && a.includes("supermarket"))).toBe(true);
    const looks = await rowsSince(from, "delivery");
    expect(looks.filter((r) => r.channel === "maps").map((r) => r.what)).toEqual(expect.arrayContaining(["route", "nearby"]));
    // The weather got a rough area only.
    const weather = world.asked.find((a) => a.includes("open-meteo"));
    expect(weather).toMatch(/latitude=28\.6&longitude=-81\.2&/);

    // Thanks is logged as its reaction.
    brain([say("Glad it helped.")]);
    await turn(s, "thanks, got it");
    const reaction = await waitFor("the reaction", async () => (await rowsSince(from, "awareness")).find((r) => r.reaction));
    expect(reaction).toMatchObject({ reaction: "thanks", kind: "errands" });
  });

  it("stays quiet when nothing is open, and when decide says it doesn't matter, without waking Atlas", async () => {
    const d = decider({ errand: 0.1 });
    seams.decide = d;
    const b = brain([]);
    const from = await lastSeq();
    await post(fixAt(north(HOME, 5_000), Date.now() - 60_000), auth);
    await post(fixAt(HOME), auth);
    const quiet = await waitFor("the quiet row", async () =>
      (await rowsSince(from, "awareness")).find((r) => String(r.event).includes("arrived at Home")),
    );
    expect(quiet).toMatchObject({ step: "rules", outcome: "quiet", why: "Nothing open it could matter to." });
    expect(quiet.ms as number).toBeLessThan(1_000);

    await inOwner(async (_a, sql) => {
      const { createItem } = await import("../src/store/agenda");
      createItem(sql, {
        kind: "errand",
        title: "Stamps",
        due_at: 8_640_000_000_000_000,
        source: { via: "chat", detail: { place_kind: "post" } },
      });
    });
    const from2 = await lastSeq();
    await post(fixAt(north(HOME, 2_000)), auth);
    const nope = await waitFor("the decide row", async () => (await rowsSince(from2, "awareness")).find((r) => r.step === "decide"));
    expect(nope).toMatchObject({ outcome: "not relevant", scores: { Stamps: 0.1 } });
    expect(b.requests).toHaveLength(0);
  });

  it("'stop' turns that kind of nudge off, says so to Atlas, and Speaking up shows it", async () => {
    seams.decide = decider({ errand: 0.9 });
    await inOwner((_a, sql) =>
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('nudges', ?, 0)`,
        JSON.stringify([{ id: "lg_x", kind: "errands", at: Date.now() - 60_000, text: "There's a Publix on your way." }]),
      ),
    );
    const b = brain([say("Okay, I'll stop.")]);
    await turn(s, "stop telling me about stores");
    expect(b.requests[0]!.system).toContain("The owner just said stop to your nudges about errands near you");
    expect(b.requests[0]!.system).toContain("off for errands near you");
    expect((await inOwner((_a, sql) => readSettings(sql))).speaking.errands).toBe(false);
  });
});

describe("on the move, and pushes", () => {
  it("wakes Atlas at most every twenty minutes on the move, but always when leaving a place", async () => {
    seams.decide = decider({ errand: 0.9 });
    await inOwner(async (_a, sql) => {
      // Earlier tests' looks are an hour old here, so the cool-down starts clear.
      sql.exec(`UPDATE log SET at = at - 3600000 WHERE kind = 'awareness'`);
      const { createItem } = await import("../src/store/agenda");
      createItem(sql, {
        kind: "errand",
        title: "Stamps",
        due_at: 8_640_000_000_000_000,
        source: { via: "chat", detail: { place_kind: "post" } },
      });
    });
    brain([say("Nothing on the way."), say("Still nothing.")]);
    const from = await lastSeq();
    await post(fixAt(north(HOME, 3_000), Date.now() - 120_000), auth);
    await waitFor("the first look", async () => (await rowsSince(from, "awareness")).find((r) => r.step === "woke"));
    await post(fixAt(north(HOME, 5_000), Date.now() - 60_000), auth);
    const cooled = await waitFor("the cool-down", async () =>
      (await rowsSince(from, "awareness")).find((r) => String(r.why).includes("every twenty minutes")),
    );
    expect(cooled).toMatchObject({ step: "rules", outcome: "quiet" });
    // Leaving a place isn't cooled down.
    await post(fixAt(GYM), auth);
    await post(fixAt(north(GYM, 700)), auth);
    await waitFor("a look on leaving", async () => (await rowsSince(from, "awareness")).filter((r) => r.step === "woke").length === 2);
  }, 20_000);

  it("counts a push opened or dismissed as a nudge's reaction, and a reply after it still counts", async () => {
    seams.decide = decider({ errand: 0 });
    await inOwner((_a, sql) =>
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('nudges', ?, 0)`,
        JSON.stringify([{ id: "lg_push", kind: "errands", at: Date.now() - 60_000, text: "There's a Publix on your way." }]),
      ),
    );
    const res = await SELF.fetch("https://atlas.test/api/reaction", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, origin: "https://atlas.test", "content-type": "application/json" },
      body: JSON.stringify({ id: "lg_push", how: "dismissed" }),
    });
    expect(res.status).toBe(200);
    const from = await lastSeq();
    brain([say("Okay.")]);
    await turn(s, "thanks, grabbed it");
    const rows = await waitFor("the reaction", async () => {
      const r = (await rowsSince(0, "awareness")).filter((x) => x.nudge === "lg_push");
      return r.length >= 2 ? r : null;
    });
    expect(rows.map((r) => r.reaction)).toEqual(["dismissed", "thanks"]);
    void from;
  });
});

describe("rhythm moments", () => {
  it("start of day is on the clock at its time, may end in silence, and logs which it chose", async () => {
    seams.decide = decider({ errand: 0 });
    const item = await inOwner(
      (_a, sql) =>
        sql
          .exec<{ id: string; due_at: number }>(
            `SELECT id, due_at FROM agenda WHERE kind = 'rhythm' AND state = 'scheduled' AND json_extract(source, '$.detail.moment') = 'morning'`,
          )
          .toArray()[0],
    );
    expect(item).toBeTruthy();
    const b = brain([say("Nothing worth saying this morning.")]);
    const from = await lastSeq();
    await inOwner(async (a, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1_000, item!.id);
      await a.onAgendaDue({ id: item!.id });
    });
    const row = await waitFor("the moment's row", async () => (await rowsSince(from, "awareness")).find((r) => r.moment === "morning"));
    expect(row).toMatchObject({ step: "woke", outcome: "silent" });
    expect(b.requests[0]!.messages.some((m) => String(m.content).includes("start of the day"))).toBe(true);
    expect(await rowsSince(from, "message.out")).toEqual([]);
    // It comes back tomorrow, on the same item.
    const again = await inOwner((_a, sql) =>
      sql.exec<{ state: string; due_at: number }>(`SELECT state, due_at FROM agenda WHERE id = ?`, item!.id).one(),
    );
    expect(again.state).toBe("scheduled");
    expect(again.due_at).toBeGreaterThan(Date.now());
  });
});

describe("ignored nudges", () => {
  it("counts a held nudge's two hours from when it's released, not when it was written", async () => {
    await inOwner(async (a, sql) => {
      const { append } = await import("../src/store/log");
      const at = Date.now() - 3 * 3_600_000;
      sql.exec(
        `INSERT OR REPLACE INTO state (key, value, updated_at) VALUES ('nudges', ?, 0)`,
        JSON.stringify([
          { id: "lg_held", kind: "evening", at, text: "Early start tomorrow." },
          { id: "lg_seen", kind: "evening", at, text: "Rain tonight." },
        ]),
      );
      append(sql, {
        actor: "atlas",
        kind: "delivery",
        body: { of: ["lg_held"], channel: "push", ok: true, held_until: Date.now() + 3_600_000 },
      });
      const tick = sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'situation' AND state = 'scheduled' LIMIT 1`).one();
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1_000, tick.id);
      await a.onAgendaDue({ id: tick.id });
      const st = JSON.parse(sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = 'nudges'`).one().value) as Array<{
        id: string;
        reaction?: string;
      }>;
      expect(st.find((n) => n.id === "lg_held")!.reaction).toBeUndefined();
      expect(st.find((n) => n.id === "lg_seen")!.reaction).toBe("ignored");
    });
  });
});

describe("rhythm moments on a cold start", () => {
  it("leaves a moment that's due for the clock, instead of moving it to tomorrow", async () => {
    const due = Date.now() - 30_000;
    await inOwner(async (a, sql) => {
      sql.exec(
        `UPDATE agenda SET due_at = ? WHERE kind = 'rhythm' AND state = 'scheduled' AND json_extract(source, '$.detail.moment') = 'morning'`,
        due,
      );
      await a.onStart();
      const row = sql
        .exec<{ due_at: number; state: string }>(
          `SELECT due_at, state FROM agenda WHERE kind = 'rhythm' AND json_extract(source, '$.detail.moment') = 'morning' ORDER BY created_at DESC LIMIT 1`,
        )
        .one();
      // Either still due (waiting for its wake) or already taken by onStart's sweep: never moved past now unseen.
      expect(row.state === "running" || row.due_at === due).toBe(true);
    });
  });
});

describe("the situation", () => {
  it("says where you are, what's next with a leave-by from a real route, and the weather", async () => {
    const start = new Date(Date.now() + 90 * 60_000).toISOString();
    const end = new Date(Date.now() + 150 * 60_000).toISOString();
    seams.calendar = fakeCalendar([
      { id: "ev1", calendar: "Home", title: "Dentist", start, end, all_day: false, location: "Dr. Patel Dental, Orlando" },
    ]);
    await post(fixAt(GYM), auth);
    const b = brain([say("You're at the gym.")]);
    await turn(s, "where am I and what's next?");
    // The refresh runs beside the turn; the next turn sees what it found.
    await waitFor("travel time", async () =>
      (
        await inOwner((_a, sql) => sql.exec(`SELECT value FROM state WHERE key = 'situation'`).toArray()[0]?.value as string | undefined)
      )?.includes('"travel":{'),
    );
    brain([say("Leave by then.")]);
    const second = brain([say("ok")]);
    await turn(s, "when should I leave?");
    const system = second.requests[0]!.system;
    expect(system).toMatch(/Where: at Gym, since/);
    expect(system).toMatch(
      /Next: "Dentist" at .*, at Dr\. Patel Dental, Orlando\. About 10 min by car from where they are \(no live traffic\)/,
    );
    expect(system).toMatch(/leave by/);
    expect(system).toMatch(/Weather near them \(Open-Meteo/);
    expect(system).not.toMatch(/28\.60/);
    void b;
  });

  it("says Atlas doesn't know where you are when location is off", async () => {
    await post(fixAt(GYM), auth);
    s.send({ type: "atlas.settings.update", patch: { location: { on: false } } });
    await s.next("atlas.view", (m) => m.view.settings.location.on === false);
    const b = brain([say("I don't know.")]);
    await turn(s, "where am I?");
    expect(b.requests[0]!.system).toContain("Where: unknown. The owner turned location off");
  });
});

describe("weather and routes, read", () => {
  it("reads Open-Meteo and says what matters today", async () => {
    const out = await fetchWeather(fakeWorld().f, { lat: 28.6, lon: -81.2 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.now.temp_c).toBe(27);
    const matters = whatMatters(out.value, "America/New_York", "us", Date.now());
    expect(matters.join(" ")).toMatch(/rain likely .* \(70%\)/);
  });

  it("encodes polylines the way Google's spec does, and samples a line", () => {
    expect(
      polyline(
        [
          [-120.2, 38.5],
          [-120.95, 40.7],
          [-126.453, 43.252],
        ],
        5,
      ),
    ).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(
      samples(
        [
          [0, 0],
          [0, 0.01],
          [0, 0.02],
        ],
        500,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
