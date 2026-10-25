// Your data (VISION §20, §23.4): a copy of everything as a tar.gz of open
// formats with no secrets in it; going back in time through Durable
// Objects' point-in-time recovery, with Undo kept in R2; and deleting
// everything, the owner's own act with a typed phrase and a hold, which
// wipes members' Atlases, the workspace and the files too. The test runtime
// keeps no history to go back to, so recovery and the restart are fakes.

import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { DataDesk, type Recovery } from "../src/agent/data";
import { keyOf, saveFile } from "../src/files";
import { savePage } from "../src/pages";
import { saveSkill, setSkillFiles, skillFileKey } from "../src/skills";
import { migrate, type Sql } from "../src/store/db";
import { createRecord } from "../src/store/records";
import { setSecret } from "../src/store/settings";
import { getState, setState } from "../src/store/state";
import { untar } from "../src/updates";
import { saveEntry } from "../src/vault";
import { env, SECRET } from "./helpers";
import { connect, inOwner } from "./owner";

const dec = new TextDecoder();

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Point-in-time recovery as Cloudflare's: a bookmark per time, one for just before each restore, and a restart. */
function fakeRecovery() {
  const calls: string[] = [];
  const r: Recovery = {
    bookmarkForTime: async (at) => {
      calls.push(`bookmark ${at}`);
      return `bm-${at}`;
    },
    restoreOnNextStart: async (b) => {
      calls.push(`restore ${b}`);
      return `undo-${calls.length}`;
    },
    restart: (why) => void calls.push(`restart ${why}`),
  };
  seams.recovery = r;
  return calls;
}

afterEach(() => {
  seams.recovery = undefined;
  seams.workspace = undefined;
});

const inAgent = <T>(name: string, fn: (sql: Sql) => Promise<T> | T) =>
  runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(name)), async (_a: PersonAgent, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });

describe("take a copy of everything", { timeout: 20_000 }, () => {
  it("is a tar.gz of every table, the settings, pages, skills and Library's files, with no secrets in it", async () => {
    await connect();
    const fileId = await inOwner(async (_a, sql) => {
      setSecret(sql, "anthropic_api_key", "sk-ant-not-a-real-key-0123456789");
      saveEntry(sql, {
        name: "Bank login",
        kind: "login",
        sites: ["bank.example"],
        values: { username: "me", password: "hunter2-very-secret" },
      });
      setState(sql, "sessions", { "session-id-that-opens-atlas": { at: Date.now(), until: Date.now() + 1e9 } });
      createRecord(sql, { type: "person", name: "Maya Chen", fields: { role: "Producer" }, source: { via: "chat" } });
      savePage(sql, { name: "Shoot plan", body: "# Shoot plan\n\nRiverside on Friday.", note: "made", by: "owner" });
      const { skill } = saveSkill(sql, {
        name: "invoice",
        description: "Sends the monthly invoice.",
        body: "Fill the invoice template, then send it to the client.",
        by: "owner",
      });
      setSkillFiles(sql, skill.id, [{ path: "templates/invoice.md", size: 9 }]);
      await env.FILES.put(skillFileKey(skill.id, "templates/invoice.md"), "INVOICE\n");
      const { file } = await saveFile(sql, env.FILES, { name: "budget.csv", body: "item,cost\ncamera,1200\n", made_by: "owner" });
      return file.id;
    });

    const res = await SELF.fetch("http://atlas.test/api/export", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const day = new Date().toISOString().slice(0, 10);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="atlas-${day}.tar.gz"`);
    const gz = new Uint8Array(await res.arrayBuffer());
    const files = untar(await gunzip(gz));
    const at = (p: string) => {
      const f = files.get(`atlas-${day}/${p}`);
      if (!f) throw new Error(`${p} isn't in the copy: ${[...files.keys()].join(", ")}`);
      return dec.decode(f);
    };

    const records = JSON.parse(at("tables/records.json")) as Array<{ name: string; fields: unknown }>;
    expect(records.find((r) => r.name === "Maya Chen")?.fields).toEqual({ role: "Producer" });
    expect(Array.isArray(JSON.parse(at("tables/log.json")))).toBe(true);
    expect(JSON.parse(at("settings.json"))).toMatchObject({ assistant_name: "Atlas", updates: { auto: false } });
    expect(at("pages/Shoot plan.md")).toBe("# Shoot plan\n\nRiverside on Friday.");
    expect(at("skills/invoice/SKILL.md")).toContain("Fill the invoice template");
    expect(at("skills/invoice/templates/invoice.md")).toBe("INVOICE\n");
    expect(at("files/budget.csv")).toBe("item,cost\ncamera,1200\n");
    expect(JSON.parse(at("secrets.json")).held).toContain("anthropic_api_key");
    expect(JSON.parse(at("vault.json"))).toEqual([
      expect.objectContaining({ name: "Bank login", sites: ["bank.example"], fields: ["username", "password"] }),
    ]);
    expect(at("README.md")).toContain("never leave Atlas");

    // Nothing that opens anything: no secrets table, no key, no vault password, no sign-in.
    expect([...files.keys()].some((k) => k.includes("tables/secrets"))).toBe(false);
    const all = [...files.values()].map((b) => dec.decode(b)).join("\n");
    for (const s of ["sk-ant-not-a-real-key-0123456789", "hunter2-very-secret", "session-id-that-opens-atlas"])
      expect(all).not.toContain(s);
    const exts = JSON.parse(at("tables/extensions.json")) as Array<Record<string, unknown>>;
    for (const e of exts) expect(e).not.toHaveProperty("key");

    // The card says it was taken, and how big it was.
    await new Promise((r) => setTimeout(r, 50));
    const last = await inOwner((_a, sql) => getState<{ last_export: { bytes: number; files: number } }>(sql, "data")?.last_export);
    expect(last?.bytes).toBe(gz.length);
    expect(last?.files).toBe([...files.keys()].length);
    expect(fileId).toBeTruthy();
  });

  it("is only for someone signed in", async () => {
    expect((await SELF.fetch("http://atlas.test/api/export")).status).toBe(401);
  });
});

describe("go back in time", { timeout: 20_000 }, () => {
  it("says what it means, takes a hold, asks Cloudflare for the time's bookmark, keeps Undo in R2, then restarts", async () => {
    const calls = fakeRecovery();
    const now = Date.now();
    await inOwner((_a, sql) => {
      // A conversation from three days ago, and one from today.
      sql.exec(`INSERT INTO log (id, at, actor, kind) VALUES ('lg_old', ?, 'owner', 'message.in')`, now - 3 * 86_400_000);
      sql.exec(`INSERT INTO log (id, at, actor, kind) VALUES ('lg_new', ?, 'owner', 'message.in')`, now - 60 * 60_000);
    });
    const s = await connect();
    const to = now - 86_400_000;

    s.send({ type: "atlas.data.preview", at: to });
    const p = await s.next("atlas.data.preview");
    expect(p.ok).toBe(true);
    expect(p.lost[0]).toMatch(/^Everything after .* is lost: \d+ messages?, and \d+ other things? in the log/);
    expect(p.kept.join(" ")).toContain("Members' own Atlases stay as they are.");

    s.send({ type: "atlas.data.restore", at: to, hold: false });
    expect((await s.next("atlas.data")).ok).toBe(false);
    s.send({ type: "atlas.data.restore", at: now - 40 * 86_400_000, hold: true });
    const old = await s.next("atlas.data");
    expect(old.ok).toBe(false);
    expect(old.text).toContain("Cloudflare keeps 30 days of history");
    expect(calls).toEqual([]);

    s.send({ type: "atlas.data.restore", at: to, hold: true });
    const done = await s.next("atlas.data");
    expect(done).toMatchObject({ what: "restore", ok: true });
    expect(done.text).toMatch(/^Going back to .*\. Atlas restarts there in a moment\.$/);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([`bookmark ${to}`, `restore bm-${to}`, "restart Going back in time"]);
    const marker = (await (await env.FILES.get("restores/owner.json"))!.json()) as { to: number; undo: string };
    expect(marker).toMatchObject({ to, undo: "undo-2" });

    // The next start reads it (R2 isn't rewound) and offers Undo, which goes back to just before.
    const view = await inOwner(async (_a, sql) => {
      const d = new DataDesk({
        sql,
        storage: null as never,
        recovery: () => seams.recovery!,
        bucket: () => env.FILES,
        name: "owner",
        member: false,
        version: () => "test",
        mcp: () => [],
        secretNames: () => [],
        changed: () => {},
        wipeMember: async () => {},
        wipeWorkspace: async () => [],
        takeDownMail: async () => [],
        discardHelpers: async () => {},
        script: () => null,
      });
      await d.start();
      return d.view();
    });
    expect(view.restore?.restored).toMatchObject({ to, undo: true });
    expect(await env.FILES.get("restores/owner.json")).toBeNull();
    calls.length = 0;
    s.send({ type: "atlas.data.restore", undo: true, hold: true });
    const undone = await s.next("atlas.data");
    expect(undone.ok).toBe(true);
    expect(undone.text).toMatch(/^Undoing going back: back to /);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual(["restore undo-2", "restart Going back in time"]);
  });
});

describe("delete everything", { timeout: 20_000 }, () => {
  it("can't be done by a member's Atlas", async () => {
    const out = await inAgent("member-mbnobody", (sql) =>
      new DataDesk({
        sql,
        storage: null as never,
        recovery: () => fakeRecovery() as never,
        bucket: () => env.FILES,
        name: "member-mbnobody",
        member: true,
        version: () => "test",
        mcp: () => [],
        secretNames: () => [],
        changed: () => {},
        wipeMember: async () => {},
        wipeWorkspace: async () => [],
        takeDownMail: async () => [],
        discardHelpers: async () => {},
        script: () => null,
      }).deleteEverything({ phrase: "delete everything", hold: true }),
    );
    expect(out).toMatchObject({ ok: false, text: "Only the owner can delete everything." });
  });

  it("takes the phrase and a hold, then deletes members' Atlases, the workspace, the files and all of the owner's storage", async () => {
    const calls = fakeRecovery();
    const wiped: string[] = [];
    seams.workspace = { wipe: async () => (wiped.push("workspace"), []) } as never;
    // A member with an Atlas of their own, with a file in it.
    const memberFile = await inAgent("member-mbdana", async (sql) => {
      createRecord(sql, { type: "note", name: "Dana's note", source: { via: "chat" } });
      return keyOf((await saveFile(sql, env.FILES, { name: "dana.txt", body: "mine", made_by: "owner" })).file);
    });
    const ownerFile = await inOwner(async (_a, sql) => {
      setState(sql, "members", [
        { id: "mbdana", name: "Dana", role: "member", invited_at: Date.now(), joined_at: Date.now(), invite_hash: null, invite_expires: 0 },
      ]);
      setSecret(sql, "anthropic_api_key", "sk-ant-not-a-real-key-0123456789");
      createRecord(sql, { type: "person", name: "Maya Chen", source: { via: "chat" } });
      return keyOf((await saveFile(sql, env.FILES, { name: "plan.txt", body: "ours", made_by: "owner" })).file);
    });
    const s = await connect();
    s.send({ type: "atlas.hello" });
    const snap = await s.next("atlas.snapshot");
    expect(snap.view.data.delete).toMatchObject({ phrase: "delete everything", members: ["Dana"] });
    expect(snap.view.data.delete!.left.join(" ")).toContain("ATLAS_OWNER_SECRET");

    s.send({ type: "atlas.data.delete", phrase: "delete it all", hold: true });
    expect((await s.next("atlas.data")).text).toBe('Type "delete everything" first.');
    s.send({ type: "atlas.data.delete", phrase: "delete everything", hold: false });
    expect((await s.next("atlas.data")).ok).toBe(false);
    expect(await env.FILES.get(ownerFile)).not.toBeNull();

    s.send({ type: "atlas.data.delete", phrase: " Delete everything ", hold: true });
    const done = await s.next("atlas.data");
    expect(done).toMatchObject({ what: "delete", ok: true });
    expect(done.left?.join(" ")).toContain("Workers & Pages → your Atlas → Settings → Delete");
    await new Promise((r) => setTimeout(r, 400));
    expect(wiped).toEqual(["workspace"]);
    expect(calls).toContain("restart Everything was deleted");
    expect(calls).toContain("restart Deleted with the owner's Atlas");

    expect(await env.FILES.get(ownerFile)).toBeNull();
    expect(await env.FILES.get(memberFile)).toBeNull();
    const left = await inOwner((_a, sql) => ({
      records: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records`).one().n,
      secrets: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM secrets`).one().n,
      members: getState(sql, "members"),
    }));
    expect(left).toEqual({ records: 0, secrets: 0, members: null });
    expect(await inAgent("member-mbdana", (sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records`).one().n)).toBe(0);
  });
});
