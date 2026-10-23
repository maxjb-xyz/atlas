// Members and shared areas (VISION §7.1, §6): an invite link, a passkey of
// their own, their own Atlas that nobody else reaches (the owner included),
// and an area the owner shares, which both see and write.

import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { createArea, getArea } from "../src/store/areas";
import { setState } from "../src/store/state";
import { call, env, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner } from "./owner";
import { authenticator, ORIGIN } from "./webauthn";

const post = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
const session = async (cookie: string) =>
  (await (await SELF.fetch(`${ORIGIN}/api/session`, { headers: { cookie } })).json()) as {
    signed_in: boolean;
    person: { member: string | null; name?: string; agent: string };
  };
const socket = (name: string, cookie: string) =>
  SELF.fetch(`${ORIGIN}/agents/person-agent/${name}`, { headers: { Upgrade: "websocket", cookie, origin: ORIGIN } });

beforeEach(async () => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  await inOwner((_a, sql) => setState(sql, "origin", ORIGIN));
});
afterEach(() => {
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.makeBrain = null;
});

/** The owner invites someone; they join with a passkey. Returns their id, cookie and authenticator. */
async function join(name: string) {
  const s = await connect();
  s.send({ type: "atlas.member.invite", name, role: "member" });
  const inv = await s.next("atlas.member.invited");
  const token = inv.link.split("/join/")[1]!;
  const opts = await post("/api/join/options", { token });
  expect(opts.status).toBe(200);
  const { name: who, options } = (await opts.json()) as { name: string; options: { challenge: string } };
  expect(who).toBe(name);
  const device = await authenticator();
  const done = await post("/api/join/verify", { token, response: await device.create(options.challenge), name: "Phone" });
  expect(done.status).toBe(204);
  // The link works once.
  expect((await post("/api/join/options", { token })).status).toBe(404);
  return { id: inv.id, cookie: cookieOf(done), device, s };
}

describe("members", { timeout: 20_000 }, () => {
  it("join with an invite link and their own passkey, and get their own Atlas that no one else's socket reaches", async () => {
    const { id, cookie, device } = await join("Dana");
    const me = await session(cookie);
    expect(me).toMatchObject({ signed_in: true, person: { member: id, name: "Dana", agent: `member-${id}` } });
    // Their socket opens their own Atlas, never the owner's.
    expect((await socket("owner", cookie)).status).toBe(404);
    expect((await socket(`member-${id}`, cookie)).status).toBe(101);
    // Signing in again with their passkey is them again.
    const lo = (await (await post("/api/passkey/login/options", {})).json()) as { challenge: string };
    const login = await post("/api/passkey/login/verify", { response: await device.get(lo.challenge) });
    expect(login.status).toBe(204);
    expect((await session(cookieOf(login))).person.member).toBe(id);
    // The owner's API is the owner's.
    expect((await SELF.fetch(`${ORIGIN}/api/log`, { headers: { cookie } })).status).toBe(403);
    // The owner's Settings lists them; their passkey isn't the owner's.
    const s = await connect();
    s.send({ type: "atlas.hello" });
    const v = await s.next("atlas.snapshot");
    expect(v.view.members.some((x) => x.id === id && x.joined_at != null)).toBe(true);
    expect(v.view.passkeys.some((p) => p.name === "Phone")).toBe(false);
  });

  it("shares an area: both see and write it, and nothing else of either is visible to the other", async () => {
    const { id, s } = await join("Sam");
    const home = await inOwner((_a, sql) => createArea(sql, { name: `Home ${id.slice(-4)}`, about: "The house", by: "owner" }));
    s.send({ type: "atlas.area.share", area: home.id, member: id, shared: true });
    await s.next("atlas.shared", (m) => m.areas.some((a) => a.id === home.id));
    expect(await inOwner((_a, sql) => getArea(sql, home.id)!.settings.shared_with)).toEqual([id]);

    // Sam's Atlas keeps something in Home, through the owner's Atlas.
    const member = env.PersonAgent.get(env.PersonAgent.idFromName(`member-${id}`));
    brain([call("shared_save", { area: home.name, name: "Plumber", fact: "The plumber comes Tuesday at 9." }), say("Kept it in Home.")]);
    await runInDurableObject(member, async (agent: PersonAgent) => {
      await (agent as unknown as { apiTurn(t: string): Promise<unknown> }).apiTurn(
        "the plumber comes tuesday at 9, put it in home for both of us",
      );
    });
    const kept = await inOwner((_a, sql) =>
      sql.exec<{ name: string; source: string }>(`SELECT name, source FROM records WHERE name = 'Plumber'`).toArray(),
    );
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]!.source).via).toBe("member:Sam");
    // Sam's words stay in Sam's Atlas: none of them is in the owner's log.
    expect(
      await inOwner(
        (_a, sql) => sql.exec(`SELECT 1 FROM log WHERE json_extract(body, '$.text') LIKE '%put it in home for both%'`).toArray().length,
      ),
    ).toBe(0);
    // Both see it.
    s.send({ type: "atlas.shared" });
    const mine = await s.next("atlas.shared", (m) => m.areas.some((a) => a.records.some((r) => r.name === "Plumber")));
    expect(mine.areas.find((a) => a.id === home.id)!.with).toEqual(expect.arrayContaining(["Sam"]));
    const theirs = await runInDurableObject(member, async (agent: PersonAgent) =>
      (agent as unknown as { apiShared(m: string): Promise<unknown> }).apiShared(id),
    );
    // A member's own Atlas has no shared areas of its own; it asks the owner's, which answers only for members.
    expect(theirs).toEqual([]);
    const fromOwner = await inOwner((agent) =>
      (agent as unknown as { apiShared(m: string): Promise<Array<{ name: string }>> }).apiShared(id),
    );
    expect(fromOwner.map((a) => a.name)).toEqual([home.name]);
    // Stopping the share stops it.
    s.send({ type: "atlas.area.share", area: home.id, member: id, shared: false });
    await s.next("atlas.shared", (m) => !m.areas.some((a) => a.id === home.id));
    expect(await inOwner((agent) => (agent as unknown as { apiShared(m: string): Promise<unknown[]> }).apiShared(id))).toEqual([]);
  });

  it("removing a member ends their sign-ins", async () => {
    const { id, cookie, s } = await join("Riley");
    s.send({ type: "atlas.member.remove", id });
    await s.next("atlas.view", (m) => !m.view.members.some((x) => x.id === id));
    expect((await session(cookie)).signed_in).toBe(false);
    expect((await socket(`member-${id}`, cookie)).status).toBe(401);
  });
});

describe("digests", () => {
  it("looks back over an area: what was said and kept there, and what's open", async () => {
    const work = await inOwner((_a, sql) => {
      const a = createArea(sql, { name: `Work ${Date.now().toString(36)}`, about: "", by: "owner" });
      sql.exec(
        `INSERT INTO records (id, type, name, fields, source, learned_at, updated_at, confidence, areas) VALUES ('rec_dg1', 'note', 'Q4 plan', ?, ?, ?, ?, 1, ?)`,
        JSON.stringify({ fact: "Ship the review tool by December." }),
        JSON.stringify({ via: "chat" }),
        Date.now(),
        Date.now(),
        JSON.stringify([a.id]),
      );
      return a;
    });
    const b = brain([call("area_look", { area: work.name, days: 7 }), say("This week in Work: the Q4 plan.")]);
    const s = await connect();
    s.send({ type: "atlas.say", text: "the week in work?", client_id: "dg" });
    await s.next("atlas.run", (m) => m.state === "replied");
    const out = String(b.requests[1]!.messages.at(-1)!.content);
    expect(out).toContain('"area":"' + work.name);
    expect(out).toContain("Ship the review tool by December.");
  });
});
