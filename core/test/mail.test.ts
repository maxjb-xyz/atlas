// Mail (VISION §10.1, §16.2): Gmail as an extension. Its look follows the
// inbox by history id, so nothing comes twice or is missed; new senders
// become people; the owner's own threads mark replies; Test says the
// newest subject and learns the owner's address.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import type { Decider } from "../src/brains/decide";
import { channelsOf, findPerson, ownerAddresses, trustOf } from "../src/contacts";
import { getExt, install, setExtSecrets, uninstall } from "../src/extensions";
import { base64url } from "../../extensions/lib/mail";
import { extensionRequests, fakeCalendar, fakeEmbedder, runExtensionsHere } from "./helpers";
import { connect, inOwner } from "./owner";

const quiet: Decider = {
  model: "fake-decide",
  async yesNo(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((k) => [k, 0.01]));
  },
};

const enc = (t: string) => base64url(new TextEncoder().encode(t));

interface Fake {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>;
  text?: string;
  html?: string;
}

/** A fake Gmail: a profile, a history that grows, and messages. */
function fakeGmail() {
  const state = { history: 100, added: [] as Array<{ at: number; m: Fake }>, messages: new Map<string, Fake>(), gone: false };
  const add = (m: Fake) => {
    state.history += 1;
    state.added.push({ at: state.history, m });
    state.messages.set(m.id, m);
  };
  const asked: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    asked.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (new Headers(init?.headers).get("authorization") !== "Bearer ya29.test") return new Response("no", { status: 401 });
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return Response.json({ emailAddress: "Owner@gmail.com", historyId: String(state.history) });
    if (path === "/history") {
      if (state.gone) return Response.json({ error: { code: 404, message: "Requested entity was not found." } }, { status: 404 });
      const start = Number(u.searchParams.get("startHistoryId"));
      const history = state.added
        .filter((a) => a.at > start)
        .map((a) => ({ messagesAdded: [{ message: { id: a.m.id, threadId: a.m.threadId, labelIds: a.m.labelIds } }] }));
      return Response.json({ history, historyId: String(state.history) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one) {
      const m = state.messages.get(one[1]!);
      if (!m) return new Response("not found", { status: 404 });
      const parts = [
        ...(m.text ? [{ mimeType: "text/plain", body: { data: enc(m.text) } }] : []),
        ...(m.html ? [{ mimeType: "text/html", body: { data: enc(m.html) } }] : []),
      ];
      return Response.json({
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: (m.text ?? "").slice(0, 50),
        payload: {
          mimeType: "multipart/alternative",
          headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
          parts,
        },
      });
    }
    if (path === "/messages") {
      const newest = [...state.added].reverse().find((a) => a.m.labelIds.includes("INBOX"));
      return Response.json(newest ? { messages: [{ id: newest.m.id, threadId: newest.m.threadId }] } : {});
    }
    return new Response("not faked", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, add, state, asked };
}

let gm: ReturnType<typeof fakeGmail>;

beforeEach(async () => {
  gm = fakeGmail();
  seams.fetch = gm.f;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.decide = quiet;
  extensionRequests.length = 0;
  runExtensionsHere();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM records WHERE type = 'person' AND json_extract(fields, '$.is_owner') IS NULL`);
    uninstall(sql, "gmail");
    install(sql, { id: "gmail", source: "bundled", state: "on" });
    setExtSecrets(sql, "gmail", { access_token: "ya29.test", expires_at: String(Date.now() + 3_600_000) });
  });
});

afterEach(() => {
  seams.fetch = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.decide = undefined;
  runExtensionsHere();
});

/** Runs the extensions' look now, as the clock would. */
async function look() {
  await inOwner(async (agent, sql) => {
    const id = sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'looks' AND state = 'scheduled'`).toArray()[0]?.id;
    if (!id) throw new Error("no look on the clock");
    sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1_000, id);
    sql.exec(`UPDATE extensions SET last_look = 0 WHERE id = 'gmail'`);
    await agent.onAgendaDue({ id });
  });
}

const mailRows = () =>
  inOwner((_a, sql) =>
    sql
      .exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'sense' AND json_extract(body, '$.source') = 'gmail' ORDER BY seq`)
      .toArray()
      .map((r) => JSON.parse(r.body) as Record<string, unknown>),
  );

describe("Gmail", () => {
  it("follows the inbox by history id: new mail once, from its sender's person, with replies marked and bulk mail making nobody", async () => {
    const s = await connect();
    // Arming happens when extensions change; any change will do.
    s.send({ type: "atlas.ext.state", id: "gmail", on: true });
    await s.next("atlas.view", (m) => m.view.extensions.some((e) => e.id === "gmail" && e.state === "on"));
    gm.add({ id: "old", threadId: "t0", labelIds: ["INBOX"], headers: { From: "x@y.com", Subject: "Before Atlas" } });
    // The first look starts from now: what was already there isn't news.
    await look();
    expect(await mailRows()).toEqual([]);
    expect(await inOwner((_a, sql) => getExt(sql, "gmail")!.cursor)).toEqual({ history: "101" });

    gm.add({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "IMPORTANT"],
      headers: {
        From: "=?UTF-8?Q?Pat_at_Bright_Smiles?= <front@brightsmiles.example>",
        To: "owner@gmail.com",
        Subject: "Your appointment moved",
        "Message-ID": "<m1@brightsmiles.example>",
      },
      text: "Hi! Your cleaning moved to Friday at 3pm. Reply to confirm.",
    });
    gm.add({ id: "m2", threadId: "t9", labelIds: ["SENT"], headers: { From: "owner@gmail.com", To: "doug@acme.com", Subject: "Lease" } });
    gm.add({
      id: "m3",
      threadId: "t3",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      headers: { From: "Deals <deals@shop.example>", Subject: "50% off", "List-Unsubscribe": "<mailto:u@shop.example>" },
      html: "<p>Big <b>sale</b> &amp; more</p>",
    });
    gm.add({ id: "m4", threadId: "t4", labelIds: ["DRAFT"], headers: { From: "owner@gmail.com", Subject: "draft" } });
    await look();
    const rows = await mailRows();
    expect(rows.map((r) => r.what)).toEqual(['Mail from Pat at Bright Smiles: "Your appointment moved"', 'Mail from Deals: "50% off"']);
    expect(rows[0]).toMatchObject({ thread: "gmail:t1", link: "https://mail.google.com/mail/u/0/#all/t1", signals: ["important"] });
    expect(rows[1]!.signals).toEqual(["promotions", "newsletter"]);
    const raw = await inOwner((_a, sql) =>
      sql
        .exec<{ raw: string }>(`SELECT raw FROM intake WHERE source = 'gmail' ORDER BY seq`)
        .toArray()
        .map((r) => r.raw),
    );
    expect(raw[0]).toContain("Your cleaning moved to Friday at 3pm.");
    expect(raw[1]).toContain("Big sale & more");
    // The new sender is a person now, trust unknown, learned from the mail; the shop isn't.
    const pat = await inOwner((_a, sql) => findPerson(sql, "email", "front@brightsmiles.example"));
    expect(pat).toMatchObject({ name: "Pat at Bright Smiles" });
    expect(trustOf(pat!)).toBe("unknown");
    expect(channelsOf(pat!)[0]!.via).toBe("mail via Gmail");
    expect(rows[0]!.person).toBe(pat!.id);
    expect(await inOwner((_a, sql) => findPerson(sql, "email", "deals@shop.example"))).toBeNull();

    // Doug answers in the thread the owner wrote on: a reply.
    gm.add({
      id: "m5",
      threadId: "t9",
      labelIds: ["INBOX"],
      headers: { From: "Doug Henderson <doug@acme.com>", Subject: "Re: Lease" },
      text: "Sounds good.",
    });
    await look();
    const reply = (await mailRows()).at(-1)!;
    expect(reply).toMatchObject({ event: "reply", signals: ["reply"] });
    expect(String(reply.what)).toContain("replying in a thread you wrote on");
    // Nothing came twice.
    expect((await mailRows()).length).toBe(3);

    // A week away, Gmail forgets the history: Atlas starts again from now, and says nothing for it.
    gm.state.gone = true;
    await look();
    expect((await mailRows()).length).toBe(3);
  });

  it("tests by reading the newest subject, and learns the owner's address", async () => {
    gm.add({ id: "n1", threadId: "t1", labelIds: ["INBOX"], headers: { From: "a@b.example", Subject: "Hello there" } });
    const s = await connect();
    s.send({ type: "atlas.ext.test", id: "gmail" });
    const t = await s.next("atlas.ext.test");
    expect(t).toMatchObject({ ok: true });
    expect(t.message).toBe('Gmail connected as Owner@gmail.com. The newest message in the inbox is "Hello there".');
    expect(await inOwner((_a, sql) => ownerAddresses(sql).has("owner@gmail.com"))).toBe(true);
    // Google's own words when it refuses.
    await inOwner((_a, sql) => setExtSecrets(sql, "gmail", { access_token: "wrong" }));
    s.send({ type: "atlas.ext.test", id: "gmail" });
    const bad = await s.next("atlas.ext.test");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("401");
  });
});
