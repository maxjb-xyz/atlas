// People (VISION §7.1) and open loops (§10.4): contacts with channels and
// trust, from an address book and from what comes in; "who's Doug?"; the
// owner kept off who an event is with; and loops that close when the answer
// comes and come back when it doesn't.

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import type { Decider } from "../src/brains/decide";
import { channelsOf, findPerson, importCards, ownerAddresses, ownerLearned, parseVCards } from "../src/contacts";
import { getExt, install, uninstall } from "../src/extensions";
import { findRecords, ownerRecord } from "../src/store/records";
import { setState } from "../src/store/state";
import type { Extension } from "../../extensions/sdk";
import { call, fakeCalendar, fakeEmbedder, runExtensionsHere, say } from "./helpers";
import { brain, connect, inOwner, turn } from "./owner";

const VCF = `BEGIN:VCARD
VERSION:3.0
FN:Doug Henderson
N:Henderson;Doug;;;
item1.EMAIL;type=INTERNET;type=pref:doug@acme.com
TEL;type=CELL:(407) 555-0134
ORG:Acme;
X-SOCIALPROFILE;type=github:https://github.com/doug-h
END:VCARD
BEGIN:VCARD
VERSION:4.0
FN:Max Owner
EMAIL:owner@icloud.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Whitfield;Dana;;;
EMAIL:dana@example.com
NOTE:The landlord\\, who lives
 downstairs
END:VCARD
BEGIN:VCARD
FN:Nobody Reachable
END:VCARD
`;

/** A test extension for mail-like items: whatever is posted to it comes in as one item from `from`. */
const postbox: Extension = {
  manifest: { id: "postbox", name: "Postbox", version: "1.0.0", about: "Test items.", provides: ["sense"], hosts: [], receives: {} },
  async receive(_ctx, req) {
    const p = JSON.parse(req.body) as { from: string; what: string; key: string; thread?: string };
    return {
      items: [{ event: "received", what: p.what, key: p.key, from: p.from, ...(p.thread ? { thread: p.thread } : {}) }],
      reply: { json: { ok: true } },
    };
  },
};

let key = "";
const post = (body: object) => SELF.fetch(`https://atlas.test/x/postbox/${key}`, { method: "POST", body: JSON.stringify(body) });

/** Decide answers nothing is worth a thought, so only rules wake Atlas. */
const quiet: Decider = {
  model: "fake-decide",
  async yesNo(_state, questions) {
    return Object.fromEntries(Object.keys(questions).map((k) => [k, 0.01]));
  },
};

beforeEach(async () => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.decide = quiet;
  runExtensionsHere({ postbox });
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM records WHERE type = 'person' AND json_extract(fields, '$.is_owner') IS NULL`);
    sql.exec(`UPDATE agenda SET state = 'cancelled' WHERE kind = 'loop' AND state = 'scheduled'`);
    uninstall(sql, "postbox");
    install(sql, { id: "postbox", source: "owner", code: "// in-process", manifest: postbox.manifest, methods: ["receive"] });
    setState(sql, "origin", "https://atlas.test");
    key = getExt(sql, "postbox")!.key;
  });
});

afterEach(() => {
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.decide = undefined;
  seams.makeBrain = null;
  runExtensionsHere();
});

describe("contacts", () => {
  it("reads vCards, merges people by a channel, puts the owner's own card on the owner, and skips cards with no way to reach anyone", async () => {
    const cards = parseVCards(VCF);
    expect(cards.map((c) => c.name)).toEqual(["Doug Henderson", "Max Owner", "Dana Whitfield", "Nobody Reachable"]);
    expect(cards[0]).toMatchObject({
      emails: ["doug@acme.com"],
      phones: ["(407) 555-0134"],
      handles: [{ kind: "github", value: "doug-h" }],
      details: { organization: "Acme" },
    });
    await inOwner((_a, sql) => {
      ownerLearned(sql, ["owner@icloud.com"], "iCloud");
      // Someone Atlas already knows by an address is merged, not made twice.
      importCards(sql, [{ name: "doug@acme.com", emails: ["doug@acme.com"], phones: [], handles: [], details: {} }], "mail");
      const out = importCards(sql, cards, "iCloud contacts");
      expect(out).toEqual({ added: 1, merged: 1, same: 1, skipped: 1 });
      const doug = findRecords(sql, "person", "Doug Henderson")[0]!;
      expect(channelsOf(doug).map((c) => `${c.kind}:${c.value}:${c.via}`)).toEqual([
        "email:doug@acme.com:mail",
        "phone:(407) 555-0134:iCloud contacts",
        "github:doug-h:iCloud contacts",
      ]);
      expect(findPerson(sql, "phone", "+1 407-555-0134")?.id).toBe(doug.id);
      expect(findPerson(sql, "github", "@Doug-H")?.id).toBe(doug.id);
      expect(
        findRecords(sql, "person")
          .filter((r) => !r.fields.is_owner)
          .map((r) => r.name)
          .sort(),
      ).toEqual(["Dana Whitfield", "Doug Henderson"]);
      expect(ownerAddresses(sql).has("owner@icloud.com")).toBe(true);
      expect(ownerRecord(sql).name).not.toBe("Max Owner");
    });
  });

  it("answers who someone is from their record: how to reach them, what's open with them, and when they were last in touch", async () => {
    await inOwner((_a, sql) => importCards(sql, parseVCards(VCF), "iCloud contacts"));
    const s = await connect();
    const b = brain([
      call("task_add", { what: "Tell Doug about the offsite", fits: { person: "Doug" } }),
      say("Kept."),
      call("person", { who: "Doug" }),
      say("Doug Henderson, doug@acme.com."),
    ]);
    await turn(s, "remind me to tell Doug about the offsite");
    // Something from Doug's address comes in: it's his, and it's the last time they were in touch.
    expect((await post({ from: "Doug Henderson <doug@acme.com>", what: "Mail from Doug: lunch?", key: "m1" })).status).toBe(200);
    await turn(s, "who's Doug?");
    const out = JSON.parse(String(b.requests[3]!.messages.at(-1)!.content)) as { people: Array<Record<string, unknown>> };
    expect(out.people[0]).toMatchObject({
      name: "Doug Henderson",
      trust: "unknown",
      channels: expect.arrayContaining([{ kind: "email", value: "doug@acme.com", from: "iCloud contacts" }]),
      open: [expect.objectContaining({ task: "Tell Doug about the offsite" })],
      last_in_touch: expect.objectContaining({ what: "Mail from Doug: lunch?" }),
    });
  });

  it("keeps a new address and trust for someone with a receipt, and the next item from that address is theirs", async () => {
    await inOwner((_a, sql) => importCards(sql, parseVCards(VCF), "iCloud contacts"));
    const s = await connect();
    brain([
      call("contact_save", { name: "Dana Whitfield", add: [{ kind: "email", value: "dana@landlords.example" }], trust: "client" }),
      say("Kept."),
    ]);
    const t = await turn(s, "Dana's other email is dana@landlords.example, and she's a client");
    expect(t.results[0]!.body.receipt).toMatchObject({
      text: "Contact · Dana Whitfield · dana@landlords.example, client",
      undo: { kind: "record.revert" },
    });
    await post({ from: "dana@landlords.example", what: "Mail from Dana", key: "m2" });
    const row = await inOwner((_a, sql) =>
      sql
        .exec<{ person: string }>(
          `SELECT json_extract(body, '$.person') AS person FROM log WHERE kind = 'sense' AND json_extract(body, '$.key') = 'm2'`,
        )
        .one(),
    );
    expect(row.person).toBe(await inOwner((_a, sql) => findRecords(sql, "person", "Dana Whitfield")[0]!.id));
  });

  it("leaves the owner off who an event is with", async () => {
    seams.calendar = fakeCalendar([
      {
        id: "e1",
        calendar: "Work",
        title: "Planning",
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() + 7_200_000).toISOString(),
        all_day: false,
        people: [
          { name: "Max", email: "Owner@iCloud.com" },
          { name: "Doug Henderson", email: "doug@acme.com" },
        ],
      },
    ]);
    await inOwner((_a, sql) => ownerLearned(sql, ["owner@icloud.com"], "iCloud"));
    const s = await connect();
    const b = brain([call("calendar_read", {}), say("Planning, with Doug.")]);
    await turn(s, "what's next?");
    const read = String(b.requests[1]!.messages.at(-1)!.content);
    expect(read).toContain("Doug Henderson <doug@acme.com>");
    expect(read.toLowerCase()).not.toContain("owner@icloud.com");
  });
});

describe("open loops", () => {
  it("closes a loop when the answer comes in, and says nothing more", async () => {
    await inOwner((_a, sql) => importCards(sql, parseVCards(VCF), "iCloud contacts"));
    const s = await connect();
    const friday = new Date(Date.now() + 3 * 86_400_000);
    const by = `${friday.getFullYear()}-${String(friday.getMonth() + 1).padStart(2, "0")}-${String(friday.getDate()).padStart(2, "0")}T17:00`;
    brain([call("loop_open", { about: "the lease renewal", waiting_on: "Dana", by }), say("I'll tell you if she hasn't by then.")]);
    const t = await turn(s, "tell me if Dana hasn't replied about the lease by Friday");
    expect(String((t.results[0]!.body.receipt as { text: string }).text)).toMatch(/^Waiting · Waiting on Dana: the lease renewal · by /);
    const open = await inOwner((_a, sql) =>
      sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'loop' AND state = 'scheduled'`).toArray(),
    );
    expect(open).toHaveLength(1);
    await post({ from: "Dana Whitfield <dana@example.com>", what: "Mail from Dana: the lease is fine", key: "m3" });
    const after = await inOwner((_a, sql) => sql.exec<{ state: string }>(`SELECT state FROM agenda WHERE id = ?`, open[0]!.id).one());
    expect(after.state).toBe("done");
  });

  it("raises a loop whose time came with nothing heard, and Atlas tells the owner once", async () => {
    const s = await connect();
    const soon = new Date(Date.now() + 3_600_000);
    const by = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}T${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
    brain([
      call("loop_open", { about: "the quote", waiting_on: "the plumber", by }),
      say("Noted."),
      (req) => {
        expect(String(req.messages.at(-1)!.content)).toContain("No answer from the plumber");
        return call("nudge", { text: "The plumber still hasn't sent the quote.", about: "the plumber's quote" });
      },
      say("Told them."),
    ]);
    await turn(s, "tell me if the plumber hasn't sent the quote in an hour");
    const id = await inOwner(
      (_a, sql) => sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'loop' AND state = 'scheduled'`).one().id,
    );
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1_000, id);
      await agent.onAgendaDue({ id });
    });
    for (let i = 0; i < 100; i++) {
      const sent = await inOwner(
        (_a, sql) =>
          sql
            .exec(`SELECT 1 FROM log WHERE kind = 'message.out' AND json_extract(body, '$.nudge.about') = 'the plumber''s quote'`)
            .toArray().length,
      );
      if (sent) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const nudged = await inOwner((_a, sql) =>
      sql
        .exec<{ text: string }>(
          `SELECT json_extract(body, '$.text') AS text FROM log WHERE kind = 'message.out' AND json_extract(body, '$.nudge.about') = 'the plumber''s quote'`,
        )
        .toArray(),
    );
    expect(nudged.map((n) => n.text)).toEqual(["The plumber still hasn't sent the quote."]);
  });
});
