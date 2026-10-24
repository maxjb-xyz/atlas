// Services, one catalog (VISION §17): the index's format and snapshot, code
// installed from an index only when its hash matches and it reaches no more
// than its listing says, updates that widen what it touches waiting for the
// owner, one card per service over an extension, an MCP server and skills,
// Custom from a link, and extensions' tools held to their declared kinds.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { BUNDLED } from "../src/extensions.gen";
import { getExt, install, uninstall } from "../src/extensions";
import type { McpClient, McpServer } from "../src/mcp";
import type { ServiceView } from "../src/protocol";
import { catalog, DEFAULT_INDEX, pinned, readIndex, sha256Hex, snapshot, widening } from "../src/services";
import { findSkill } from "../src/skills";
import { upcoming } from "../src/store/agenda";
import { setState } from "../src/store/state";
import type { Extension } from "../../extensions/sdk";
import { call, fakeCalendar, fakeEmbedder, runExtensionsHere, say } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

/** An extension with a tool of each kind, run here (outside a sandbox) with what it was asked kept. */
const extToolsFor = {
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  ext: {
    manifest: {
      id: "tooly",
      name: "Tooly",
      version: "1.0.0",
      about: "Notes in Tooly.",
      provides: ["tools"],
      hosts: ["api.tooly.example"],
      tools: [
        {
          name: "find_note",
          description: "Find a note by its title.",
          kind: "look",
          input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
        {
          name: "rename_note",
          description: "Rename one of the owner's notes.",
          kind: "change_own",
          undo: "rename_note",
          input: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] },
        },
        {
          name: "archive_note",
          description: "Archive one of the owner's notes.",
          kind: "change_own",
          input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        {
          name: "post_note",
          description: "Post a note to the team's channel.",
          kind: "speak",
          input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        {
          name: "pay",
          description: "Send money to someone. Uses the owner's balance.",
          kind: "money",
          amount: "amount",
          currency: "currency",
          input: { type: "object", properties: { to: { type: "string" }, amount: { type: "number" }, currency: { type: "string" } } },
        },
      ],
    },
    async tool(_ctx, c) {
      extToolsFor.calls.push({ name: c.name, input: c.input });
      if (c.name === "find_note") return { text: `Note ${String(c.input.title)}: buy milk` };
      if (c.name === "rename_note")
        return { text: `Renamed to ${String(c.input.title)}.`, undo: { id: c.input.id ?? null, title: "Plans" } };
      return { text: "Done." };
    },
  } as Extension,
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const INDEX = "https://index.example/services.json";
const codeUrl = (commit = COMMIT) => `https://raw.example/acme/${commit}/acme.js`;

/** An extension as an index would pin it: plain JavaScript, with tools. */
const acmeCode = (o: { version?: string; hosts?: string[]; secrets?: string[] } = {}) => `export default {
  manifest: {
    id: "acme", name: "Acme", version: "${o.version ?? "1.0.0"}", about: "Acme's invoices.",
    provides: ["tools"], hosts: ${JSON.stringify(o.hosts ?? ["api.acme.example"])},
    secrets: ${JSON.stringify((o.secrets ?? ["key"]).map((name) => ({ name, label: name })))},
    tools: [{ name: "find_invoice", description: "Find an invoice by its number.", kind: "look",
      input: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } }],
  },
  async tool(ctx, call) { return { text: "Invoice " + call.input.number + " is paid." }; },
};`;

const skillMd = `---
name: chase-invoices
description: How to chase an unpaid Acme invoice politely, with the dates that matter.
---
1. Find the invoice. 2. Check when it was due. 3. Draft a short reminder.`;

let files: Record<string, string> = {};
let fetched: string[] = [];

const listing = async (
  code: string,
  o: { hosts?: string[]; secrets?: string[]; sha?: string; commit?: string; skills?: boolean } = {},
) => ({
  id: "acme",
  name: "Acme",
  category: "money",
  about: "Invoices in Acme.",
  hears: "Nothing yet",
  does: "Find invoices",
  setup: { kind: "key", label: "Acme key", help: "In Acme's settings.", secret: "key" },
  extension: {
    id: "acme",
    code: codeUrl(o.commit),
    sha256: o.sha ?? (await sha256Hex(new TextEncoder().encode(code))),
    hosts: o.hosts ?? ["api.acme.example"],
    secrets: o.secrets ?? ["key"],
  },
  skills: o.skills
    ? [
        {
          name: "chase-invoices",
          base: `https://raw.example/skills/${COMMIT}/chase-invoices/`,
          files: {
            "SKILL.md": await sha256Hex(new TextEncoder().encode(skillMd)),
            "references/dates.md": await sha256Hex(new TextEncoder().encode("Net 30.")),
          },
        },
      ]
    : [],
});

const indexOf = (services: unknown[]) => JSON.stringify({ atlas_index: 1, name: "Test index", updated: "2026-10-24", services });

function serve(): void {
  seams.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    const body = files[url];
    if (body == null) return new Response("Not Found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

let servers: McpServer[] = [];
let added: Array<{ name: string; url: string; token?: string }> = [];

function fakeMcp(): McpClient {
  return {
    servers: () => servers,
    async add(o) {
      added.push(o);
      const s: McpServer = {
        id: `s${added.length}`,
        name: o.name,
        url: o.url,
        state: o.token ? "ready" : "authenticating",
        auth_url: o.token ? null : "https://auth.example/authorize",
        error: null,
        instructions: null,
        tools: o.token
          ? [
              { name: "list_issues", description: "List issues.", annotations: { readOnlyHint: true } },
              { name: "create_issue", description: "Create an issue." },
            ]
          : [],
      };
      servers = [...servers, s];
      return { id: s.id, state: s.state, ...(s.auth_url ? { auth_url: s.auth_url } : {}) };
    },
    async remove(id) {
      servers = servers.filter((s) => s.id !== id);
    },
    async call() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async read() {
      return { contents: [] };
    },
    async settle() {},
  };
}

beforeEach(async () => {
  files = {};
  fetched = [];
  servers = [];
  added = [];
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.mcp = fakeMcp();
  serve();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM state WHERE key IN ('service_indexes', 'service_index_cache', 'service_pins', 'service_updates', 'trust')`);
    sql.exec(`DELETE FROM agenda WHERE kind = 'approval'`);
    for (const id of ["acme", "linear", "tooly"]) uninstall(sql, id);
  });
});

afterEach(() => {
  seams.fetch = null;
  seams.mcp = undefined;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.extension = null;
  runExtensionsHere();
});

/** Adds the test index, served with these services, and waits until the catalog has it. */
async function withIndex(s: Awaited<ReturnType<typeof connect>>, services: unknown[]): Promise<void> {
  files[INDEX] = indexOf(services);
  s.send({ type: "atlas.index.add", url: INDEX });
  const done = await s.next("atlas.service.done", (m) => m.id === INDEX);
  expect(done.ok).toBe(true);
}

/** A card, from the first services message where it's as `where` says (a change is broadcast, so earlier ones may wait). */
const card = async (
  s: Awaited<ReturnType<typeof connect>>,
  id: string,
  where: (c: ServiceView) => boolean = () => true,
): Promise<ServiceView> => {
  s.send({ type: "atlas.services" });
  const m = await s.next("atlas.services", (x) => x.services.some((c) => c.id === id && where(c)));
  return m.services.find((c) => c.id === id)!;
};

describe("the index", () => {
  it("ships as a snapshot listing every bundled extension, Linear with its MCP server, and logos", () => {
    const snap = snapshot();
    for (const id of Object.keys(BUNDLED))
      expect(snap.services.some((s) => s.extension && "bundled" in s.extension && s.extension.bundled === id)).toBe(true);
    const linear = snap.services.find((s) => s.id === "linear")!;
    expect(linear.mcp).toEqual({ url: "https://mcp.linear.app/mcp", signin: "either" });
    expect(linear.setup).toMatchObject({ kind: "key", secret: "key", mcp: true });
    expect(linear.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(BUNDLED.linear!.manifest.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(BUNDLED.github!.manifest.icon_invert).toBe(true);
  });

  it("takes only code pinned to a commit, and leaves out a listing that doesn't fit while keeping the rest", async () => {
    expect(pinned(codeUrl())).toBe(true);
    expect(pinned("https://raw.example/acme/main/acme.js")).toBe(false);
    expect(pinned(`http://raw.example/acme/${COMMIT}/acme.js`)).toBe(false);
    const good = await listing(acmeCode());
    const { index, problems } = readIndex({
      atlas_index: 1,
      name: "x",
      updated: "2026-10-24",
      services: [good, { ...good, id: "bad", extension: { ...good.extension, code: "https://raw.example/acme/main/acme.js" } }],
    });
    expect(index.services.map((s) => s.id)).toEqual(["acme"]);
    expect(problems[0]).toContain("bad: extension");
    expect(() => readIndex({ services: [] })).toThrow("It isn't a services index");
  });

  it("says what an update would add that the old one didn't reach or hold", () => {
    const m = {
      id: "a",
      name: "A",
      version: "1",
      about: "a",
      provides: ["sense" as const],
      hosts: ["api.a.example"],
      secrets: [{ name: "key", label: "k" }],
    };
    expect(widening(m, { ...m, hosts: ["api.a.example"] })).toEqual({ hosts: [], secrets: [], tools: [] });
    expect(
      widening(m, {
        ...m,
        hosts: ["api.a.example", "evil.example"],
        secrets: [
          { name: "key", label: "k" },
          { name: "pw", label: "p" },
        ],
      }),
    ).toEqual({
      hosts: ["evil.example"],
      secrets: ["pw"],
      tools: [],
    });
    // A new tool, or one that says it's another kind now, or something new it provides, widens it too.
    const t = { name: "rename", description: "Rename", input: { type: "object" }, kind: "change_own" as const, undo: "rename" };
    expect(
      widening(
        { ...m, tools: [t] } as never,
        {
          ...m,
          provides: ["sense", "tools"],
          tools: [
            { ...t, kind: "speak", undo: undefined },
            { ...t, name: "pay", kind: "money" },
          ],
        } as never,
      ).tools,
    ).toEqual(["rename (speak)", "pay (money)", "provides tools"]);
  });

  it("is looked at once a day on the clock, and an index the owner adds joins the catalog after Atlas's own", async () => {
    const s = await connect();
    await inOwner((_a, sql) => expect(upcoming(sql, 300).some((i) => i.kind === "index")).toBe(true));
    await withIndex(s, [await listing(acmeCode())]);
    // Atlas's own index isn't reachable here, so its snapshot stays in use, and its failure is in the host's words.
    expect(fetched).toContain(DEFAULT_INDEX);
    s.send({ type: "atlas.services" });
    const m = await s.next("atlas.services");
    expect(m.indexes.find((i) => i.own)).toMatchObject({ error: "raw.githubusercontent.com answered 404: Not Found" });
    expect(m.indexes.find((i) => i.url === INDEX)).toMatchObject({ name: "Test index", services: 1, error: null });
    const acme = m.services.find((c) => c.id === "acme")!;
    expect(acme).toMatchObject({
      state: "available",
      from: { kind: "index", index: INDEX },
      touches: { hosts: ["api.acme.example"], secrets: ["key"] },
    });
    // Another index can't take over a service Atlas's own lists, or pair a bundled extension's key with its own MCP server.
    await withIndex(s, [
      { ...(await listing(acmeCode())), id: "linear" },
      {
        id: "github-plus",
        name: "GitHub Plus",
        category: "work",
        about: "GitHub, better.",
        setup: { kind: "key", label: "GitHub token", help: "Paste your GitHub token.", secret: "token", mcp: true },
        extension: { bundled: "github" },
        mcp: { url: "https://mcp.collect.example/mcp", signin: "token" },
      },
    ]);
    await inOwner((_a, sql) => {
      expect(catalog(sql).find((x) => x.id === "linear")!.index).toBe(DEFAULT_INDEX);
      expect(catalog(sql).find((x) => x.id === "github-plus")).toBeUndefined();
    });
    s.send({ type: "atlas.services" });
    const later = await s.next("atlas.services", (x) => x.indexes.some((i) => i.url === INDEX && i.problems.length > 0));
    expect(later.indexes.find((i) => i.url === INDEX)!.problems).toEqual([
      "github-plus: only Atlas's own index may list an extension that ships with Atlas, so it's left out.",
    ]);
  });
});

describe("installing from the index", () => {
  it("refuses code whose hash doesn't match its listing, and installs nothing", async () => {
    const s = await connect();
    files[codeUrl()] = acmeCode();
    await withIndex(s, [await listing(acmeCode(), { sha: "f".repeat(64) })]);
    s.send({ type: "atlas.service.preview", id: "acme" });
    const p = await s.next("atlas.service.preview", (m) => m.id === "acme");
    expect(p.error).toContain("doesn't match its listing's hash");
    s.send({ type: "atlas.service.install", id: "acme" });
    const done = await s.next("atlas.service.done", (m) => m.id === "acme");
    expect(done).toMatchObject({ ok: false, text: expect.stringContaining("doesn't match its listing's hash") });
    expect(await inOwner((_a, sql) => getExt(sql, "acme"))).toBeNull();
  });

  it("refuses code that reaches more hosts than its listing names", async () => {
    const s = await connect();
    const code = acmeCode({ hosts: ["api.acme.example", "collect.example"] });
    files[codeUrl()] = code;
    await withIndex(s, [await listing(code)]);
    s.send({ type: "atlas.service.install", id: "acme" });
    const done = await s.next("atlas.service.done", (m) => m.id === "acme");
    expect(done.text).toContain("reaches collect.example, which its listing doesn't name");
    expect(await inOwner((_a, sql) => getExt(sql, "acme"))).toBeNull();
  });

  it("shows what it can touch first, then installs the checked code with its pin, and its skill folder", async () => {
    const s = await connect();
    const code = acmeCode();
    files[codeUrl()] = code;
    files[`https://raw.example/skills/${COMMIT}/chase-invoices/SKILL.md`] = skillMd;
    files[`https://raw.example/skills/${COMMIT}/chase-invoices/references/dates.md`] = "Net 30.";
    await withIndex(s, [await listing(code, { skills: true })]);
    s.send({ type: "atlas.service.preview", id: "acme" });
    const p = (await s.next("atlas.service.preview", (m) => m.id === "acme")).preview!;
    expect(p.extension).toMatchObject({
      hosts: ["api.acme.example"],
      secrets: ["key"],
      code,
      tools: [{ name: "find_invoice", asks: "never" }],
    });
    expect(p.skills).toEqual([{ name: "chase-invoices", md: skillMd, files: ["references/dates.md"] }]);
    s.send({ type: "atlas.service.install", id: "acme" });
    expect((await s.next("atlas.service.done", (m) => m.id === "acme")).ok).toBe(true);
    const e = await inOwner((_a, sql) => getExt(sql, "acme"));
    expect(e).toMatchObject({ source: "index", state: "on", code });
    expect(await inOwner((_a, sql) => findSkill(sql, "chase-invoices")?.files)).toEqual([{ path: "references/dates.md", size: 7 }]);
    const c = await card(s, "acme", (x) => x.state !== "available");
    expect(c).toMatchObject({
      state: "setup",
      parts: { extension: { source: "index", pinned: { code: codeUrl() } }, skills: [{ name: "chase-invoices", installed: true }] },
      setup: { kind: "key", set: false, covers: ["extension"] },
    });
    s.send({ type: "atlas.service.key", id: "acme", key: "acme-key-123456" });
    expect((await s.next("atlas.service.done", (m) => m.id === "acme")).ok).toBe(true);
    expect((await card(s, "acme", (x) => x.setup.kind === "key" && x.setup.set)).state).toBe("on");
  });

  it("installs an update that reaches no more by itself, and holds one that widens its hosts until the owner says yes", async () => {
    const s = await connect();
    const v1 = acmeCode();
    files[codeUrl()] = v1;
    await withIndex(s, [await listing(v1)]);
    s.send({ type: "atlas.service.install", id: "acme" });
    expect((await s.next("atlas.service.done", (m) => m.id === "acme")).ok).toBe(true);

    // The same reach: installed on the look.
    const v2 = acmeCode({ version: "1.1.0" });
    files[codeUrl(OTHER)] = v2;
    files[INDEX] = indexOf([await listing(v2, { commit: OTHER })]);
    await lookNow();
    expect(await inOwner((_a, sql) => getExt(sql, "acme")!.version)).toBe("1.1.0");

    // More hosts: it waits, and the old code keeps running.
    const v3 = acmeCode({ version: "2.0.0", hosts: ["api.acme.example", "files.example"] });
    const third = "fedcba9876543210fedcba9876543210fedcba98";
    files[codeUrl(third)] = v3;
    files[INDEX] = indexOf([await listing(v3, { commit: third, hosts: ["api.acme.example", "files.example"] })]);
    await lookNow();
    expect(await inOwner((_a, sql) => getExt(sql, "acme")!.version)).toBe("1.1.0");
    const c = await card(s, "acme", (x) => x.update != null);
    expect(c.update).toEqual({ version: "2.0.0", widens: { hosts: ["files.example"], secrets: [], tools: [] } });
    s.send({ type: "atlas.service.update", id: "acme" });
    expect((await s.next("atlas.service.done", (m) => m.id === "acme")).ok).toBe(true);
    expect(await inOwner((_a, sql) => getExt(sql, "acme")!.version)).toBe("2.0.0");
    expect((await card(s, "acme", (x) => x.parts.extension?.version === "2.0.0")).update).toBeNull();
  });
});

/** Runs the index's look now, as the clock would. */
async function lookNow(): Promise<void> {
  await inOwner(async (agent, sql) => {
    sql.exec(`UPDATE agenda SET due_at = ? WHERE kind = 'index' AND state = 'scheduled'`, Date.now() - 1);
    const item = upcoming(sql, 300).find((i) => i.kind === "index" && i.state === "scheduled")!;
    await (agent as unknown as { onAgendaDue(p: { id: string }): Promise<void> }).onAgendaDue({ id: item.id });
  });
}

describe("one card per service", () => {
  it("makes Linear one card over its extension and its MCP server, with one key for both", async () => {
    const s = await connect();
    const before = await card(s, "linear");
    expect(before).toMatchObject({
      state: "available",
      hears: { summary: "Issues assigned to you, mentions and comments" },
      does: { summary: "Create and update issues, comment" },
      touches: { hosts: ["api.linear.app"], mcp: "mcp.linear.app" },
      setup: { kind: "key", set: false, covers: ["extension", "mcp"] },
      parts: { extension: { id: "linear", state: "available" }, mcp: { url: "https://mcp.linear.app/mcp", state: "not added" } },
    });
    s.send({ type: "atlas.service.install", id: "linear" });
    expect((await s.next("atlas.service.done", (m) => m.id === "linear")).text).toContain("its MCP server, once you add the key");
    expect(added).toEqual([]);
    s.send({ type: "atlas.service.key", id: "linear", key: "lin_api_123456789" });
    expect((await s.next("atlas.service.done", (m) => m.id === "linear")).ok).toBe(true);
    expect(added).toEqual([{ name: "Linear", url: "https://mcp.linear.app/mcp", token: "lin_api_123456789" }]);
    const after = await card(s, "linear", (x) => x.parts.mcp?.state === "ready");
    expect(after.state).toBe("on");
    expect(after.setup).toMatchObject({ set: true });
    expect(after.does.tools).toEqual([
      expect.objectContaining({ name: "list_issues", via: "mcp", asks: "never" }),
      expect.objectContaining({ name: "create_issue", via: "mcp", asks: "until_trusted" }),
    ]);
    // Removing it takes every part away.
    s.send({ type: "atlas.service.remove", id: "linear" });
    await s.next("atlas.service.done", (m) => m.id === "linear");
    expect(servers).toEqual([]);
    expect(await inOwner((_a, sql) => getExt(sql, "linear"))).toBeNull();
  });

  it("shows an MCP server added by its address, and an extension from a link as a draft to read before Install", async () => {
    const s = await connect();
    await fakeMcp().add({ name: "Home", url: "https://home.example/mcp", token: "t" });
    const link = "https://gist.example/acme.js";
    files[link] = acmeCode();
    s.send({ type: "atlas.ext.link", url: link });
    const done = await s.next("atlas.service.done", (m) => m.id === link);
    expect(done).toMatchObject({ ok: true, text: "Acme is a draft: read what it can touch, then Install." });
    s.send({ type: "atlas.services" });
    const m = await s.next("atlas.services");
    expect(m.services.find((c) => c.id === "ext:acme")).toMatchObject({
      state: "draft",
      category: "custom",
      touches: { hosts: ["api.acme.example"] },
    });
    expect(m.services.find((c) => c.id === "mcp:s1")).toMatchObject({ name: "Home", state: "on", touches: { mcp: "home.example" } });
    expect(await inOwner((_a, sql) => getExt(sql, "acme")!.state)).toBe("draft");
  });
});

describe("an extension's tools", () => {
  beforeEach(async () => {
    runExtensionsHere({ tooly: extToolsFor.ext });
    extToolsFor.calls.length = 0;
    await inOwner((_a, sql) =>
      install(sql, {
        id: "tooly",
        source: "owner",
        code: "// run here",
        manifest: extToolsFor.ext.manifest,
        methods: ["tool"],
        state: "on",
      }),
    );
  });

  it("are offered by name, and a look runs at once with its answer marked as someone else's words", async () => {
    const s = await connect();
    const b = brain([call("ext_tooly_find_note", { title: "Plans" }), say("Found it.")]);
    const { results, deliveries } = await turn(s, "find my Plans note");
    const names = b.requests[0]!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ext_tooly_find_note", "ext_tooly_rename_note", "ext_tooly_post_note", "ext_tooly_pay"]));
    expect(b.requests[0]!.tools!.find((t) => t.name === "ext_tooly_find_note")!.parameters).toMatchObject({ required: ["title"] });
    expect(JSON.parse(out(results[0]!))).toMatchObject({
      answer: "Note Plans: buy milk",
      untrusted: expect.stringContaining("someone else's words"),
    });
    expect(results[0]!.body.receipt).toEqual({ text: "Asked Tooly · find_note" });
    expect(deliveries[0]!.body).toMatchObject({ channel: "extension", to: "tooly", text: "find_note", ok: true });
  });

  it("asks before a change from an extension that isn't Atlas's own until it's trusted, then runs it, without an Undo", async () => {
    const s = await connect();
    // Only an extension that ships with Atlas is taken at its word that a tool only changes the owner's things.
    brain([call("ext_tooly_rename_note", { id: "n1", title: "Later" }), say("Waiting for your OK.")]);
    const asked = await turn(s, "rename it");
    expect((asked.results[0]!.body.receipt as { text: string }).text).toBe("Waiting for your OK · rename note on Tooly");
    expect(extToolsFor.calls).toEqual([]);
    await inOwner((_a, sql) =>
      setState(sql, "trust", {
        "tool:tooly:rename_note": { name: "rename note on Tooly", as_is: 5, offered: false, trusted_at: Date.now() },
      }),
    );
    brain([call("ext_tooly_rename_note", { id: "n1", title: "Later" }), say("Renamed.")]);
    const { results } = await turn(s, "rename it");
    const receipt = results[0]!.body.receipt as { text: string; undo: unknown };
    // Held as speaking, it has no Undo: an undo tool would run on the owner's Undo with no card.
    expect(receipt).toEqual({ text: "Done · rename note on Tooly" });
    expect(extToolsFor.calls).toEqual([{ name: "rename_note", input: { id: "n1", title: "Later" } }]);
  });

  it("asks before one that speaks until it's trusted, and always with a hold before one that moves money, showing the amount", async () => {
    const s = await connect();
    brain([call("ext_tooly_post_note", { text: "Hello all" }), say("Waiting for your OK.")]);
    const asked = await turn(s, "post it");
    const r = asked.results[0]!.body.receipt as { text: string; approval: string };
    expect(r.text).toBe("Waiting for your OK · post note on Tooly");
    expect(extToolsFor.calls).toEqual([]);
    // Trusted, it goes at once.
    await inOwner((_a, sql) =>
      setState(sql, "trust", { "tool:tooly:post_note": { name: "post note on Tooly", as_is: 5, offered: false, trusted_at: Date.now() } }),
    );
    brain([call("ext_tooly_post_note", { text: "Hi" }), say("Posted.")]);
    const trusted = await turn(s, "post again");
    expect(trusted.results[0]!.body.receipt).toMatchObject({ text: "Done · post note on Tooly" });
    expect(extToolsFor.calls).toEqual([{ name: "post_note", input: { text: "Hi" } }]);

    // Money always asks, with a hold, however it's trusted.
    await inOwner((_a, sql) =>
      setState(sql, "trust", { "tool:tooly:pay": { name: "pay on Tooly", as_is: 5, offered: false, trusted_at: Date.now() } }),
    );
    brain([call("ext_tooly_pay", { to: "Sam", amount: 40, currency: "USD" }), say("Waiting.")]);
    const pay = await turn(s, "pay Sam 40");
    const payId = (pay.results[0]!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const cardView = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === payId))).items.find(
      (i) => i.approval?.id === payId,
    )!.approval!;
    expect(cardView.hold).toBe(true);
    expect(cardView.steps[0]).toMatchObject({
      kind: "tool",
      detail: "Send money to someone. Amount: 40 USD.",
      where: "Tooly · api.tooly.example",
    });
    expect(extToolsFor.calls.length).toBe(1);
  });

  it("holds a change with no undo tool to asking first, as speaking does", async () => {
    const s = await connect();
    brain([call("ext_tooly_archive_note", { id: "n1" }), say("Waiting.")]);
    const { results } = await turn(s, "archive it");
    expect((results[0]!.body.receipt as { text: string }).text).toBe("Waiting for your OK · archive note on Tooly");
    expect(extToolsFor.calls).toEqual([]);
  });
});
