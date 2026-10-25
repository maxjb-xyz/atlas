// Skill hubs (VISION §9.3, §17: skills, pinned the same way, including from
// skill hubs that use SKILL.md). A hub is a public GitHub repo of skill
// folders, such as Anthropic's, listed in an index and pinned there to a
// commit. Atlas reads that commit's list of files from GitHub's API once (a
// commit never changes, so what it read is kept), and each SKILL.md from
// raw.githubusercontent.com for Get skills; installing fetches the whole
// folder at that commit. Every file is checked against git's own hash for
// it in the commit's list, so what's installed is exactly what the commit
// holds, and anything else is refused with nothing kept.
//
// The folder is kept in R2 unchanged, the hub's own SKILL.md beside it, and
// the skill says where it came from. A skill from a hub is someone else's
// instructions that the owner chose to install, so it's used like one of
// theirs; its scripts run only in the workspace, as every skill's do. When
// the index pins the hub to a newer commit, a folder that's the same stays as
// it is, and one that changed waits for the owner's Update, read in full
// first.

import { fetchBytes, hubCatalog, type ListedHub } from "../services";
import {
  findSkill,
  frontmatter,
  getSkill,
  parseSkillMd,
  saveSkill,
  setSkillFiles,
  setSkillSource,
  setSkillState,
  type Skill,
  type SkillFile,
  skillFileKey,
  skillSources,
  slug,
} from "../skills";
import type { HubPreview, HubSkillView, HubView, SkillView } from "../protocol";
import type { Sql } from "../store/db";
import { getState, setState } from "../store/state";

export interface HubDeps {
  sql: Sql;
  fetch(): typeof fetch;
  /** Where skills' files live (R2), or null. */
  files(): R2Bucket | null;
}

/** The most a hub's list of files, one of its files, and one skill's folder may be. */
const MAX_TREE_BYTES = 8_000_000;
export const MAX_HUB_FILE = 5_000_000;
const MAX_FOLDER_FILES = 300;
const MAX_FOLDER_BYTES = 30_000_000;
/** The most skills Atlas lists from one hub. */
const MAX_SKILLS = 200;
/** A hub that couldn't be read is tried again when Get skills opens, after this long. */
const RETRY_MS = 10 * 60_000;
/** How many files are fetched at once. */
const AT_ONCE = 6;

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** A file in a skill's folder at the hub's commit: its path inside the folder, git's hash for it, and its size. */
export interface HubFile {
  path: string;
  sha: string;
  size: number;
}

/** A skill as a hub holds it at its commit. */
export interface HubSkill {
  /** Its name, from its SKILL.md (the folder's name when that can't be read). */
  name: string;
  description: string;
  license: string | null;
  /** The folder in the repo: "skills/pptx". */
  folder: string;
  files: HubFile[];
  /** Why it can't be installed, when it can't. */
  problem: string | null;
}

interface HubList {
  at: number;
  error: string | null;
  skills: HubSkill[] | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (commit: string) => commit.slice(0, 7);
const listKey = (h: { repo: string; commit: string; path: string }) => `${h.repo}@${h.commit}/${h.path}`;
const within = (folder: string, path: string) => (folder ? `${folder}/${path}` : path);

/** Where a hub's folder is on GitHub, at its commit. */
export const hubUrl = (repo: string, commit: string, folder: string) =>
  `https://github.com/${repo}/tree/${commit}${folder ? `/${folder}` : ""}`;

const rawUrl = (repo: string, commit: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A name Atlas can keep a file under, in R2 and in the workspace's shell: letters, digits, dots, dashes, underscores and pluses. */
export const keepable = (path: string) =>
  path.length <= 240 && /^[A-Za-z0-9._+\-/]+$/.test(path) && path.split("/").every((p) => p && p !== "." && p !== "..");

/** Git's hash for a file's bytes (a blob's SHA-1), the one a commit's list of files names it by. */
export async function gitHash(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", all)), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A commit's list of files, from GitHub's API, unauthenticated. Fails in GitHub's own words, with the status. */
async function githubTree(f: typeof fetch, repo: string, commit: string): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`;
  let res: Response;
  try {
    res = await f(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Atlas", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Couldn't reach api.github.com: ${errText(err)}`);
  }
  const raw = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Said below, with the status.
  }
  if (!res.ok) {
    const said = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : raw.slice(0, 200);
    throw new Error(`api.github.com answered ${res.status} for ${repo} at ${short(commit)}${said ? `: ${said}` : ""}`);
  }
  if (raw.length > MAX_TREE_BYTES) throw new Error(`GitHub's list of ${repo}'s files is bigger than Atlas reads (${raw.length} bytes).`);
  const b = body as { tree?: unknown; truncated?: unknown } | null;
  if (!b || !Array.isArray(b.tree)) throw new Error(`api.github.com sent something that isn't a list of ${repo}'s files.`);
  if (b.truncated)
    throw new Error(`GitHub cut its list of ${repo}'s files short (it has too many), so Atlas can't tell a folder is whole.`);
  return b.tree as TreeEntry[];
}

/**
 * The skill folders under `base` in a commit's list of files: every folder
 * with a SKILL.md, each with the files under it that aren't in a deeper
 * skill's folder, and why it can't be kept when it can't.
 */
export function skillFolders(tree: TreeEntry[], base: string): Array<{ folder: string; files: HubFile[]; problem: string | null }> {
  const pre = base ? `${base}/` : "";
  const under = tree.filter((e) => !base || e.path.startsWith(pre));
  const dirs = under
    .filter((e) => e.type === "blob" && (e.path === `${pre}SKILL.md` || e.path.endsWith("/SKILL.md")))
    .map((e) => e.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""))
    .sort((a, b) => b.length - a.length);
  const out = new Map(dirs.map((d) => [d, { folder: d, files: [] as HubFile[], problems: [] as string[] }]));
  for (const e of under) {
    if (e.type === "tree") continue;
    const dir = dirs.find((d) => !d || e.path.startsWith(`${d}/`));
    if (dir === undefined) continue;
    const k = out.get(dir)!;
    const rel = dir ? e.path.slice(dir.length + 1) : e.path;
    if (e.type === "commit") k.problems.push(`${rel} is another repository (a submodule), which a folder can't hold`);
    else if (e.mode === "120000") k.problems.push(`${rel} is a link, which Atlas doesn't follow`);
    else if (!keepable(rel)) k.problems.push(`${rel} has a name Atlas can't keep (letters, digits, dots, dashes and underscores only)`);
    else k.files.push({ path: rel, sha: e.sha, size: e.size ?? 0 });
  }
  return [...out.values()]
    .map((k) => {
      const bytes = k.files.reduce((n, f) => n + f.size, 0);
      const big = k.files.find((f) => f.size > MAX_HUB_FILE);
      const problem =
        k.problems[0] ??
        (k.files.length > MAX_FOLDER_FILES
          ? `it has ${k.files.length} files, more than the ${MAX_FOLDER_FILES} Atlas keeps for a skill`
          : bytes > MAX_FOLDER_BYTES
            ? `it's ${Math.round(bytes / 1e6)} MB, more than the ${MAX_FOLDER_BYTES / 1e6} MB Atlas keeps for a skill`
            : big
              ? `${big.path} is ${Math.round(big.size / 1e6)} MB, more than the ${MAX_HUB_FILE / 1e6} MB Atlas keeps for one file`
              : null);
      return { folder: k.folder, files: k.files.sort((a, b) => (a.path < b.path ? -1 : 1)), problem };
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Runs `fn` over `items`, a few at a time. */
async function inTurn<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(fn))));
  return out;
}

const sameFiles = (pinned: Record<string, string>, files: HubFile[]) =>
  Object.keys(pinned).length === files.length && files.every((f) => pinned[f.path] === f.sha);

/** Words of a search, lowercased, with a plural's s taken off ("slides" finds "slide decks"). */
const words = (q: string) =>
  q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "make", "making", "skill", "skills", "get"].includes(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

export class HubDesk {
  constructor(private readonly d: HubDeps) {}

  #lists(): Record<string, HubList> {
    return getState<Record<string, HubList>>(this.d.sql, "skill_hub_lists") ?? {};
  }

  /** Keeps what a hub holds, and drops what's kept for hubs (or commits) the catalog no longer lists. */
  #note(h: ListedHub, l: HubList): void {
    const keep = new Set(hubCatalog(this.d.sql).map(listKey));
    const all = Object.fromEntries(Object.entries(this.#lists()).filter(([k]) => keep.has(k)));
    all[listKey(h)] = l;
    setState(this.d.sql, "skill_hub_lists", all);
  }

  #hub(id: string): ListedHub {
    const h = hubCatalog(this.d.sql).find((x) => x.id === id);
    if (!h) throw new Error(`There's no skill hub called "${id}" in the catalog.`);
    return h;
  }

  /** Fetches one file of a hub's folder at its commit and checks it's the file git names there. */
  async #file(h: ListedHub, folder: string, f: HubFile): Promise<Uint8Array> {
    const path = within(folder, f.path);
    const bytes = await fetchBytes(this.d.fetch(), rawUrl(h.repo, h.commit, path), MAX_HUB_FILE);
    const got = await gitHash(bytes);
    if (got !== f.sha)
      throw new Error(
        `What raw.githubusercontent.com sent for ${path} isn't that file at ${h.repo}'s commit ${short(h.commit)} (git's hash for it is ${f.sha.slice(0, 12)}…, this one's is ${got.slice(0, 12)}…), so nothing was installed.`,
      );
    return bytes;
  }

  /** Reads what a hub holds at its commit: its list of files, then each skill's SKILL.md for its name and what it's for. */
  async #read(h: ListedHub): Promise<HubSkill[]> {
    try {
      const found = skillFolders(await githubTree(this.d.fetch(), h.repo, h.commit), h.path).slice(0, MAX_SKILLS);
      const skills = await inTurn(found, async (k): Promise<HubSkill> => {
        const md = k.files.find((f) => f.path === "SKILL.md")!;
        const fallback = slug(k.folder.split("/").pop() || h.repo.split("/")[1]!);
        const base = { folder: k.folder, files: k.files, license: null, description: "" };
        if (md.size > MAX_HUB_FILE) return { ...base, name: fallback, problem: k.problem ?? "its SKILL.md is too big to read" };
        const text = new TextDecoder().decode(await this.#file(h, k.folder, md));
        try {
          const p = parseSkillMd(text);
          const fm = frontmatter(/^---\s*\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n").trimStart())?.[1] ?? "");
          return { ...base, name: slug(p.name) || fallback, description: p.description, license: fm.license || null, problem: k.problem };
        } catch (err) {
          return { ...base, name: fallback, problem: `its SKILL.md doesn't read: ${errText(err)}` };
        }
      });
      const seen = new Set<string>();
      for (const k of skills) {
        if (seen.has(k.name)) k.problem ??= `another folder in ${h.name} has the same name`;
        seen.add(k.name);
      }
      this.#note(h, { at: Date.now(), error: null, skills });
      return skills;
    } catch (err) {
      const error = errText(err);
      console.error(JSON.stringify({ at: "hubs.read", hub: h.id, repo: h.repo, commit: h.commit, error }));
      this.#note(h, { at: Date.now(), error, skills: null });
      throw err;
    }
  }

  /** What a hub holds: kept from before (a pinned commit doesn't change), else read now. */
  async #list(h: ListedHub): Promise<HubSkill[]> {
    return this.#lists()[listKey(h)]?.skills ?? this.#read(h);
  }

  async #skill(hub: string, name: string): Promise<{ h: ListedHub; k: HubSkill }> {
    const h = this.#hub(hub);
    const all = await this.#list(h);
    const k = all.find((x) => x.name === slug(name)) ?? all.find((x) => x.folder.split("/").pop() === name);
    if (!k)
      throw new Error(
        `${h.name} has no skill called "${name}". It has: ${all
          .map((x) => x.name)
          .slice(0, 40)
          .join(", ")}.`,
      );
    return { h, k };
  }

  /** Reads every hub that hasn't been read yet, or (after a while, or with `again`) one that failed. Failures are kept in GitHub's words. */
  async read(o: { again?: boolean } = {}): Promise<void> {
    for (const h of hubCatalog(this.d.sql)) {
      const l = this.#lists()[listKey(h)];
      if (l?.skills || (l?.error && !o.again && Date.now() - l.at < RETRY_MS)) continue;
      await this.#read(h).catch(() => undefined);
    }
  }

  /** Whether any hub hasn't been read yet (or failed a while ago), so Get skills should read before it's whole. */
  unread(): boolean {
    const lists = this.#lists();
    return hubCatalog(this.d.sql).some((h) => {
      const l = lists[listKey(h)];
      return !l || (!l.skills && Date.now() - l.at >= RETRY_MS);
    });
  }

  views(): HubView[] {
    const lists = this.#lists();
    return hubCatalog(this.d.sql).map((h) => {
      const l = lists[listKey(h)];
      return {
        id: h.id,
        name: h.name,
        about: h.about ?? null,
        repo: h.repo,
        commit: h.commit,
        url: hubUrl(h.repo, h.commit, h.path),
        index: h.index,
        at: l?.at ?? null,
        error: l?.error ?? null,
        skills: l?.skills?.map((k) => this.#view(h, k)) ?? null,
      };
    });
  }

  #view(h: ListedHub, k: HubSkill): HubSkillView {
    const s = findSkill(this.d.sql, k.name);
    const src = s ? skillSources(this.d.sql)[s.id] : undefined;
    const ours = Boolean(s && src && src.repo === h.repo && src.folder === k.folder);
    return {
      name: k.name,
      description: k.description,
      license: k.license,
      folder: k.folder,
      files: k.files.length,
      bytes: k.files.reduce((n, f) => n + f.size, 0),
      problem: k.problem,
      installed:
        ours && s!.state === "active"
          ? { id: s!.id, commit: src!.commit, update: src!.commit !== h.commit && !sameFiles(src!.files, k.files) }
          : null,
      taken: Boolean(s && !ours),
    };
  }

  /** Where a skill came from, for the Skills page: its hub, the commit it's at, and whether the hub's newer pin changed it. */
  from(id: string): SkillView["from"] {
    const src = skillSources(this.d.sql)[id];
    if (!src) return null;
    const h = hubCatalog(this.d.sql).find((x) => x.id === src.hub && x.repo === src.repo);
    const k = h ? this.#lists()[listKey(h)]?.skills?.find((x) => x.folder === src.folder) : undefined;
    return {
      hub: src.hub,
      name: h?.name ?? src.hub_name,
      repo: src.repo,
      commit: src.commit,
      folder: src.folder,
      url: hubUrl(src.repo, src.commit, src.folder),
      update: Boolean(h && k && h.commit !== src.commit && !sameFiles(src.files, k.files)),
    };
  }

  /** One skill in full, fetched at the hub's commit and checked, to read before it's installed. */
  async preview(hub: string, name: string): Promise<HubPreview> {
    const { h, k } = await this.#skill(hub, name);
    const md = k.files.find((f) => f.path === "SKILL.md")!;
    return {
      hub: h.id,
      name: k.name,
      md: new TextDecoder().decode(await this.#file(h, k.folder, md)),
      files: k.files.filter((f) => f !== md).map((f) => ({ path: f.path, size: f.size })),
      license: k.license,
      url: hubUrl(h.repo, h.commit, k.folder),
    };
  }

  /**
   * Installs a hub's skill, or its update: every file in its folder fetched
   * at the hub's commit and checked against git's hash for it, then the skill
   * saved from its SKILL.md (a new version when it changed), the folder kept
   * in R2 as it is, and where it came from. A skill of the same name that
   * didn't come from this hub is never written over.
   */
  async install(
    hub: string,
    name: string,
    o: { run_id?: string | null } = {},
  ): Promise<{ skill: Skill; change: "installed" | "updated" | "same"; text: string }> {
    const sql = this.d.sql;
    const { h, k } = await this.#skill(hub, name);
    if (k.problem) throw new Error(`${k.name} from ${h.name} can't be installed: ${k.problem}.`);
    const had = findSkill(sql, k.name);
    const src = had ? skillSources(sql)[had.id] : undefined;
    if (had && (!src || src.repo !== h.repo || src.folder !== k.folder))
      throw new Error(
        `There's already a skill called ${k.name}${src ? ` from ${src.hub_name}` : had.made_by === "atlas" ? " that Atlas learned" : " that you made"}${had.state === "archived" ? " (archived)" : ""}, so ${h.name}'s wasn't installed over it.`,
      );
    if (had && src && had.state === "active" && (src.commit === h.commit || sameFiles(src.files, k.files))) {
      if (src.commit !== h.commit) setSkillSource(sql, had.id, { ...src, commit: h.commit, index: h.index, at: Date.now() });
      return { skill: had, change: "same", text: `${k.name} is installed from ${h.name}, as the hub has it now.` };
    }
    const bucket = this.d.files();
    if (!bucket && k.files.length > 1) throw new Error(`${k.name} has files, and this deployment has no bucket for them.`);
    const got = await inTurn(k.files, async (f) => ({ path: f.path, bytes: await this.#file(h, k.folder, f) }));
    const md = got.find((f) => f.path === "SKILL.md")!;
    const p = parseSkillMd(new TextDecoder().decode(md.bytes));
    const back = had?.state === "archived";
    const saved = saveSkill(sql, {
      ...p,
      name: k.name,
      by: "owner",
      note: `${had ? (back ? "Installed again" : "Updated") : "Installed"} from ${h.name} (${h.repo} at ${short(h.commit)}).`,
      run_id: o.run_id ?? null,
    });
    const skill = saved.skill;
    if (skill.state !== "active") setSkillState(sql, skill.id, "active", "owner", `Installed again from ${h.name}.`);
    if (bucket) {
      const keep = new Set(got.map((f) => f.path));
      for (const old of [...Object.keys(src?.files ?? {}), ...skill.files.map((f) => f.path)])
        if (!keep.has(old)) await bucket.delete(skillFileKey(skill.id, old));
      for (const f of got) await bucket.put(skillFileKey(skill.id, f.path), f.bytes);
    }
    const files: SkillFile[] = got.filter((f) => f !== md).map((f) => ({ path: f.path, size: f.bytes.length }));
    setSkillFiles(sql, skill.id, files);
    setSkillSource(sql, skill.id, {
      hub: h.id,
      hub_name: h.name,
      index: h.index,
      repo: h.repo,
      folder: k.folder,
      commit: h.commit,
      version: getSkill(sql, skill.id)!.version,
      files: Object.fromEntries(k.files.map((f) => [f.path, f.sha])),
      at: Date.now(),
    });
    const change = had && !back ? "updated" : "installed";
    return {
      skill: getSkill(sql, skill.id)!,
      change,
      text: `${change === "updated" ? "Updated" : "Installed"} ${k.name} from ${h.name}${files.length ? `, with ${files.length} ${files.length === 1 ? "file" : "files"} in its folder` : ""}.`,
    };
  }

  /** Removes a hub's skill: archived, so it's out of what Atlas uses and can come back with Install. */
  remove(hub: string, name: string): string {
    const s = findSkill(this.d.sql, slug(name));
    const src = s ? skillSources(this.d.sql)[s.id] : undefined;
    if (!s || !src || src.hub !== hub) throw new Error(`${name} wasn't installed from that hub.`);
    if (s.state === "archived") return `${s.name} was already removed.`;
    setSkillState(this.d.sql, s.id, "archived", "owner", `Removed; it came from ${src.hub_name}.`);
    return `Removed ${s.name}. Install brings it back.`;
  }

  /** Searches every hub's skills by the words of what they're for, best first. */
  async find(query: string, limit = 8): Promise<{ skills: Array<HubSkillView & { hub: string; hub_name: string }>; unread: string[] }> {
    const unread: string[] = [];
    const all: Array<{ h: ListedHub; k: HubSkill }> = [];
    for (const h of hubCatalog(this.d.sql)) {
      try {
        for (const k of await this.#list(h)) all.push({ h, k });
      } catch (err) {
        unread.push(`${h.name}: ${errText(err)}`);
      }
    }
    const want = words(query);
    const score = ({ k }: { k: HubSkill }) => {
      const name = words(k.name.replace(/-/g, " "));
      const about = words(k.description);
      return want.reduce((n, w) => n + (name.some((x) => x.startsWith(w)) ? 3 : 0) + (about.some((x) => x.startsWith(w)) ? 1 : 0), 0);
    };
    const ranked = all.map((x) => ({ ...x, score: score(x) })).filter((x) => !want.length || x.score > 0);
    ranked.sort((a, b) => b.score - a.score || a.k.name.localeCompare(b.k.name));
    return { skills: ranked.slice(0, limit).map(({ h, k }) => ({ ...this.#view(h, k), hub: h.id, hub_name: h.name })), unread };
  }

  /**
   * After the daily look at the indexes: a skill installed at a commit its hub
   * has moved on from is looked at in the new commit. One whose folder is the
   * same moves to the new commit as it is; one that changed waits for Update.
   */
  async look(): Promise<void> {
    const sql = this.d.sql;
    const hubs = hubCatalog(sql);
    for (const [id, src] of Object.entries(skillSources(sql))) {
      const h = hubs.find((x) => x.id === src.hub && x.repo === src.repo);
      if (!h || h.commit === src.commit) continue;
      try {
        const k = (await this.#list(h)).find((x) => x.folder === src.folder);
        if (k && sameFiles(src.files, k.files)) setSkillSource(sql, id, { ...src, commit: h.commit, index: h.index, at: Date.now() });
      } catch (err) {
        console.error(JSON.stringify({ at: "hubs.look", hub: h.id, skill: id, error: errText(err) }));
      }
    }
  }
}
