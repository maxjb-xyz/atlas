// Skill hubs (VISION §9.3, §17): a GitHub repo of skill folders pinned to a
// commit in an index. Get skills lists what it holds from the commit's own
// list of files, a skill opens in full before it's installed, its folder is
// installed unchanged with every file checked against git's hash for it (and
// refused when one isn't), its script runs in the workspace, Download gives
// the folder back, Atlas finds and installs one when asked with Undo, and a
// newer pin is an update only for a folder that changed. A fake GitHub
// stands in for the real one.

import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams, type WorkspaceStub } from "../src/agent";
import { gitHash, skillFolders } from "../src/agent/hubs";
import type { HubView } from "../src/protocol";
import { findSkill, saveSkill } from "../src/skills";
import { upcoming } from "../src/store/agenda";
import { call, fakeCalendar, fakeEmbedder, SECRET, say } from "./helpers";
import { brain, connect, inOwner, out, turn, type Socket } from "./owner";

const COMMIT = "1111111111aaaaaaaaaa2222222222bbbbbbbbbb";
const NEWER = "3333333333cccccccccc4444444444dddddddddd";
const INDEX = "https://index.example/hubs.json";
const REPO = "acme/skills";

// A SKILL.md as skills from other agents write them: a long description folded over lines, and a license.
const SLIDES_MD = `---
name: slides
description: >
  Make slide decks as .pptx files, from an outline or notes.
  Use when the owner asks for slides, a deck or a presentation.
license: Apache-2.0
---

# Slides

1. Write the outline.
2. Run \`python3 scripts/build.py outline.md\` from this folder.
3. Check the layouts in references/layouts.md.
`;
const NOTES_MD = (v: string) => `---
name: notes
description: "Take meeting notes in the \\"house\\" format, with actions at the end."
---

1. Headings for each topic. ${v}
`;

/** The hub at each commit: every file under the repo, by path. */
const repo: Record<string, Record<string, string>> = {};
let tampered: Record<string, string> = {};
let fetched: string[] = [];

function hubAt(commit: string, notes = "Keep it short."): void {
  repo[commit] = {
    "README.md": "Acme's skills.",
    "skills/slides/SKILL.md": SLIDES_MD,
    "skills/slides/scripts/build.py": "print('built the deck')\n",
    "skills/slides/references/layouts.md": "Title, then two columns.\n",
    "skills/slides/LICENSE.txt": "Apache License 2.0\n",
    "skills/notes/SKILL.md": NOTES_MD(notes),
    "skills/linky/SKILL.md": "---\nname: linky\ndescription: A skill with a link in its folder, which can't be kept.\n---\n\nSteps.\n",
  };
}

async function tree(commit: string): Promise<unknown> {
  const files = repo[commit]!;
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: await gitHash(new TextEncoder().encode(text)),
      size: new TextEncoder().encode(text).length,
    })),
  );
  return {
    sha: commit,
    truncated: false,
    tree: [
      { path: "skills", mode: "040000", type: "tree", sha: "0".repeat(40) },
      ...entries,
      { path: "skills/linky/shared", mode: "120000", type: "blob", sha: "1".repeat(40), size: 9 },
    ],
  };
}

const indexOf = (commit: string) =>
  JSON.stringify({
    atlas_index: 1,
    name: "Hubs",
    updated: "2026-10-25",
    services: [],
    hubs: [{ id: "acme", name: "Acme", about: "Acme's skills.", repo: REPO, commit, path: "skills" }],
  });
let index = indexOf(COMMIT);

let commands: string[] = [];

beforeEach(async () => {
  hubAt(COMMIT);
  tampered = {};
  fetched = [];
  index = indexOf(COMMIT);
  commands = [];
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url === INDEX) return new Response(index);
    const t = /^https:\/\/api\.github\.com\/repos\/acme\/skills\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(url);
    if (t && repo[t[1]!]) return Response.json(await tree(t[1]!));
    const r = /^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/([0-9a-f]{40})\/(.+)$/.exec(url);
    const path = r ? decodeURIComponent(r[2]!) : "";
    if (r && tampered[path] != null) return new Response(tampered[path]);
    if (r && repo[r[1]!]?.[path] != null) return new Response(repo[r[1]!]![path]!);
    if (url.startsWith("https://api.github.com/")) return Response.json({ message: "Not Found" }, { status: 404 });
    return new Response("404: Not Found", { status: 404 });
  };
  const ws: WorkspaceStub = {
    async run(o) {
      commands.push(o.command);
      const enc = new TextEncoder();
      const lines = [
        { out: o.command.includes("build.py") ? "built the deck\n" : "" },
        { done: { exit: 0, ms: 5, blocked: [], kept: "" } },
      ];
      return new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
          c.close();
        },
      });
    },
    async read() {
      return { ok: false, error: "no" };
    },
    async list() {
      return null;
    },
    async preview() {
      return { token: "x", expires: 0 };
    },
    async restart() {},
    async status() {
      return { running: false, ready: true };
    },
  };
  seams.workspace = ws;
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM skills`);
    sql.exec(`DELETE FROM skill_versions`);
    sql.exec(`DELETE FROM state WHERE key IN ('service_indexes', 'service_index_cache', 'skill_sources', 'skill_hub_lists')`);
  });
});

afterEach(() => {
  seams.fetch = null;
  seams.workspace = undefined;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

/** Adds the test index, then waits until Get skills has read its hub. */
async function withHub(s: Socket): Promise<HubView> {
  s.send({ type: "atlas.index.add", url: INDEX });
  expect((await s.next("atlas.service.done", (m) => m.id === INDEX)).ok).toBe(true);
  return hub(s);
}

const hub = async (s: Socket, where: (h: HubView) => boolean = (h) => h.skills != null): Promise<HubView> => {
  s.send({ type: "atlas.hubs" });
  const m = await s.next("atlas.hubs", (x) => x.hubs.some((h) => h.id === "acme" && where(h)));
  return m.hubs.find((h) => h.id === "acme")!;
};

/** The files in a zip Atlas made (stored, so each file's bytes follow its header). */
function unzip(b: Uint8Array): Record<string, string> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Record<string, string> = {};
  let i = 0;
  while (v.getUint32(i, true) === 0x04034b50) {
    const size = v.getUint32(i + 18, true);
    const n = v.getUint16(i + 26, true);
    const name = new TextDecoder().decode(b.subarray(i + 30, i + 30 + n));
    out[name] = new TextDecoder().decode(b.subarray(i + 30 + n, i + 30 + n + size));
    i += 30 + n + size;
  }
  return out;
}

describe("a skill hub", () => {
  it("finds the skill folders in a commit's list of files, each with the files that are its own", async () => {
    const t = (await tree(COMMIT)) as { tree: Parameters<typeof skillFolders>[0] };
    const folders = skillFolders(t.tree, "skills");
    expect(folders.map((f) => f.folder)).toEqual(["skills/linky", "skills/notes", "skills/slides"]);
    expect(folders[2]!.files.map((f) => f.path)).toEqual(["LICENSE.txt", "SKILL.md", "references/layouts.md", "scripts/build.py"]);
    expect(folders[0]!.problem).toContain("shared is a link");
    expect(skillFolders(t.tree, "")).toHaveLength(3);
  });

  it("lists what it holds at its pinned commit, and shows one in full before it's installed", async () => {
    const s = await connect();
    const h = await withHub(s);
    expect(h).toMatchObject({
      name: "Acme",
      repo: REPO,
      commit: COMMIT,
      url: `https://github.com/${REPO}/tree/${COMMIT}/skills`,
      error: null,
    });
    const slides = h.skills!.find((k) => k.name === "slides")!;
    expect(slides).toMatchObject({
      description:
        "Make slide decks as .pptx files, from an outline or notes. Use when the owner asks for slides, a deck or a presentation.",
      license: "Apache-2.0",
      folder: "skills/slides",
      files: 4,
      problem: null,
      installed: null,
      taken: false,
    });
    expect(h.skills!.find((k) => k.name === "notes")!.description).toBe(
      'Take meeting notes in the "house" format, with actions at the end.',
    );
    expect(h.skills!.find((k) => k.name === "linky")!.problem).toContain("link");
    // One look at the commit's files, then only each SKILL.md: the folders' other files wait for an install.
    expect(fetched.filter((u) => u.includes("api.github.com/repos/acme"))).toHaveLength(1);
    expect(fetched.some((u) => u.endsWith("build.py"))).toBe(false);

    s.send({ type: "atlas.hub.preview", hub: "acme", name: "slides" });
    const p = await s.next("atlas.hub.preview", (m) => m.name === "slides");
    expect(p.preview).toMatchObject({
      md: SLIDES_MD,
      license: "Apache-2.0",
      url: `https://github.com/${REPO}/tree/${COMMIT}/skills/slides`,
    });
    expect(p.preview!.files.map((f) => f.path)).toEqual(["LICENSE.txt", "references/layouts.md", "scripts/build.py"]);

    // A pinned commit doesn't change, so opening Get skills again reads nothing.
    const acme = () => fetched.filter((u) => u.includes("acme/skills")).length;
    const before = acme();
    await hub(s);
    expect(acme()).toBe(before);
  }, 20_000);

  it("installs the folder unchanged, runs its script in the workspace, and gives the folder back", async () => {
    const s = await connect();
    await withHub(s);
    s.send({ type: "atlas.hub.install", hub: "acme", name: "slides" });
    const done = await s.next("atlas.hub.done", (m) => m.name === "slides");
    expect(done).toMatchObject({ ok: true, text: "Installed slides from Acme, with 3 files in its folder." });
    const skill = await inOwner((_a, sql) => findSkill(sql, "slides")!);
    expect(skill).toMatchObject({ made_by: "owner", state: "active", version: 1 });
    expect(skill.files.map((f) => f.path)).toEqual(["LICENSE.txt", "references/layouts.md", "scripts/build.py"]);
    expect(
      (await hub(s, (h) => Boolean(h.skills?.find((k) => k.name === "slides")?.installed))).skills!.find((k) => k.name === "slides")!
        .installed,
    ).toEqual({ id: skill.id, commit: COMMIT, update: false });
    s.send({ type: "atlas.skills" });
    const views = await s.next("atlas.skills", (m) => m.skills.some((k) => k.name === "slides"));
    expect(views.skills.find((k) => k.name === "slides")!.from).toEqual({
      hub: "acme",
      name: "Acme",
      repo: REPO,
      commit: COMMIT,
      folder: "skills/slides",
      url: `https://github.com/${REPO}/tree/${COMMIT}/skills/slides`,
      update: false,
    });

    // Its script runs in the workspace, from its folder there, with the hub's own SKILL.md beside it.
    brain([
      call("skill_read", { name: "slides" }),
      call("skill_file", { name: "slides", unpack: true }),
      call("workspace_run", { command: "cd /workspace/skills/slides && python3 scripts/build.py outline.md" }),
      say("Built the deck."),
    ]);
    const ran = await turn(s, "make me slides from my outline");
    expect(out(ran.results[0]!)).toContain("Acme's skill hub (acme/skills)");
    expect(out(ran.results[1]!)).toContain("/workspace/skills/slides");
    expect(out(ran.results[2]!)).toContain("built the deck");
    const b64 = (t: string) => btoa(t);
    expect(commands.some((c) => c.includes(`printf %s '${b64(SLIDES_MD)}' > /workspace/skills/slides/SKILL.md.b64`))).toBe(true);
    expect(commands.some((c) => c.includes("mkdir -p /workspace/skills/slides/scripts && "))).toBe(true);
    expect(commands.some((c) => c.includes("chmod +x /workspace/skills/slides/scripts/build.py"))).toBe(true);
    expect(
      commands.some((c) => c.includes("base64 -d /workspace/skills/slides/LICENSE.txt.b64 > /workspace/skills/slides/LICENSE.txt")),
    ).toBe(true);

    // Download: the folder as a zip, its SKILL.md byte for byte as the hub has it.
    const res = await SELF.fetch(`http://atlas.test/api/skills/${skill.id}/folder`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(unzip(new Uint8Array(await res.arrayBuffer()))).toEqual({
      "slides/SKILL.md": SLIDES_MD,
      "slides/LICENSE.txt": "Apache License 2.0\n",
      "slides/references/layouts.md": "Title, then two columns.\n",
      "slides/scripts/build.py": "print('built the deck')\n",
    });
  }, 20_000);

  it("refuses a file that isn't the one the commit holds, keeps nothing, and never installs over a skill of the same name", async () => {
    const s = await connect();
    await withHub(s);
    tampered["skills/slides/scripts/build.py"] = "import os; os.system('curl collect.example')\n";
    s.send({ type: "atlas.hub.install", hub: "acme", name: "slides" });
    const bad = await s.next("atlas.hub.done", (m) => m.name === "slides");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("isn't that file at acme/skills's commit 1111111");
    expect(await inOwner((_a, sql) => findSkill(sql, "slides"))).toBeNull();

    await inOwner((_a, sql) =>
      saveSkill(sql, {
        name: "notes",
        description: "How the owner likes their own notes.",
        body: "1. Bullet points, never prose.",
        by: "owner",
      }),
    );
    s.send({ type: "atlas.hub.install", hub: "acme", name: "notes" });
    const taken = await s.next("atlas.hub.done", (m) => m.name === "notes");
    expect(taken).toMatchObject({ ok: false, text: expect.stringContaining("already a skill called notes that you made") });
    expect(await inOwner((_a, sql) => findSkill(sql, "notes")!.body)).toBe("1. Bullet points, never prose.");
    expect((await hub(s, (h) => Boolean(h.skills?.find((k) => k.name === "notes")?.taken))).skills).toBeTruthy();
  }, 20_000);

  it("finds and installs one when the owner asks, with Undo that removes it", async () => {
    const s = await connect();
    s.send({ type: "atlas.index.add", url: INDEX });
    await s.next("atlas.service.done", (m) => m.id === INDEX);
    brain([
      call("skill_find", { query: "a skill for making slides" }),
      call("skill_install", { hub: "acme", name: "slides" }),
      say("Installed the slides skill."),
    ]);
    const got = await turn(s, "get a skill for making slides");
    const found = JSON.parse(out(got.results[0]!)) as { skills: Array<{ hub: string; name: string }> };
    expect(found.skills[0]).toMatchObject({ hub: "acme", name: "slides" });
    const receipt = got.results[1]!.body.receipt as { text: string; undo: unknown };
    expect(receipt).toMatchObject({ text: "Installed a skill · slides from Acme" });
    const skill = await inOwner((_a, sql) => findSkill(sql, "slides")!);
    expect(receipt.undo).toEqual({ kind: "skill.uninstall", id: skill.id });

    const row = await inOwner((_a, sql) =>
      sql
        .exec<{ id: string }>(
          `SELECT id FROM log WHERE run_id = ? AND kind = 'tool.result' AND json_extract(body, '$.name') = 'skill_install'`,
          got.run,
        )
        .one(),
    );
    s.send({ type: "atlas.undo", log_id: row.id });
    await s.next("atlas.skills", (m) => m.skills.some((k) => k.name === "slides" && k.state === "archived"));
    expect((await hub(s)).skills!.find((k) => k.name === "slides")!.installed).toBeNull();

    // Install brings it back, from the same folder.
    s.send({ type: "atlas.hub.install", hub: "acme", name: "slides" });
    expect((await s.next("atlas.hub.done", (m) => m.name === "slides")).ok).toBe(true);
    expect(await inOwner((_a, sql) => findSkill(sql, "slides")!.state)).toBe("active");
  }, 20_000);

  it("moves a folder that didn't change to the hub's newer pin as it is, and offers Update for one that did", async () => {
    const s = await connect();
    await withHub(s);
    for (const name of ["slides", "notes"]) {
      s.send({ type: "atlas.hub.install", hub: "acme", name });
      expect((await s.next("atlas.hub.done", (m) => m.name === name)).ok).toBe(true);
    }
    hubAt(NEWER, "Keep it short, and name who owns each action.");
    index = indexOf(NEWER);
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE kind = 'index' AND state = 'scheduled'`, Date.now() - 1);
      const item = upcoming(sql, 300).find((i) => i.kind === "index" && i.state === "scheduled")!;
      await (agent as unknown as { onAgendaDue(p: { id: string }): Promise<void> }).onAgendaDue({ id: item.id });
    });
    s.send({ type: "atlas.skills" });
    const views = (await s.next("atlas.skills", (m) => m.skills.some((k) => k.from?.commit === NEWER))).skills;
    expect(views.find((k) => k.name === "slides")!.from).toMatchObject({ commit: NEWER, update: false });
    expect(views.find((k) => k.name === "notes")!.from).toMatchObject({ commit: COMMIT, update: true });
    const h = await hub(s, (x) => x.commit === NEWER && x.skills != null);
    expect(h.skills!.find((k) => k.name === "notes")!.installed).toMatchObject({ commit: COMMIT, update: true });

    s.send({ type: "atlas.hub.install", hub: "acme", name: "notes" });
    expect(await s.next("atlas.hub.done", (m) => m.name === "notes")).toMatchObject({ ok: true, text: "Updated notes from Acme." });
    const notes = await inOwner((_a, sql) => findSkill(sql, "notes")!);
    expect(notes.version).toBe(2);
    expect(notes.body).toContain("name who owns each action");
  }, 20_000);
});
