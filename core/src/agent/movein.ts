// Moving in (VISION §23.3), the agent's side: a file the app sent goes to its
// reader in the sandbox, skill folders wait in R2 for the owner's OK, the
// extraction reads what was gathered in chunks on the helpers' brain, and the
// owner's keep or drop writes records and installs skills. Every brain call
// is part of one run, which ends in one saved state.

import type { BrainRouter } from "../brains/router";
import { brainKey, type Usage } from "../brains/types";
import { BUNDLED } from "../extensions.gen";
import { type ExtensionHost, getExt, install, type Installed, installed } from "../extensions";
import {
  addFound,
  AT_ONCE,
  chunksOf,
  chunkText,
  current,
  dropItem,
  endMoveIn,
  extractSystem,
  gathered,
  getMoveIn,
  keepItem,
  type MoveIn,
  type MoveItem,
  noteDecision,
  parseFound,
  type ReadOut,
  saveMoveIn,
  takeRead,
} from "../movein";
import type { MoveInView } from "../protocol";
import { cleanPath, readerTakes } from "../readers";
import { keepable } from "./hubs";
import { findSkill, getSkill, parseSkillMd, saveSkill, setSkillFiles, setSkillState, skillFileKey, type SkillFile } from "../skills";
import type { Sql } from "../store/db";
import { endRun, startRun } from "../store/runs";
import { chainFor, readSettings } from "../store/settings";
import type { Manifest, ReaderSpec } from "../../../extensions/sdk";

/** The most one part of a file may be, as the app sends it. */
export const PART_BYTES = 8_000_000;
/** One skill folder: its files, and all of them together. */
const SKILL_FILE_BYTES = 1_000_000;
const SKILL_BYTES = 8_000_000;
const SKILL_FILES = 60;

export interface MoveInDeps {
  sql: Sql;
  host: ExtensionHost;
  router: BrainRouter;
  bucket(): R2Bucket | null;
  /** The view changed: send it to the owner's screens. */
  changed(view: MoveInView): void;
  /** Work that goes on after the call that started it answered. */
  background(fn: () => Promise<void>): void;
  /** Records or skills changed. */
  recordsChanged(): void;
  skillsChanged(): void;
}

const isReader = (m: Manifest): m is Manifest & { reads: ReaderSpec } => m.provides.includes("reader") && Boolean(m.reads);
/** Where a reader sits in the list: the ones people ask for most first, then the rest by name. */
const rank = (order: string[], id: string) => (order.includes(id) ? order.indexOf(id) : order.length);

export class MoveInDesk {
  /** A reading runs in this instance now; after a restart a "learning" move-in is shown as paused. */
  #learning = false;

  constructor(private readonly d: MoveInDeps) {}

  /** Every reader Atlas has: the ones that ship with it, and any installed from an index or written. */
  readers(): Array<{ id: string; manifest: Manifest & { reads: ReaderSpec } }> {
    const mine = installed(this.d.sql).filter((e) => e.state === "on" && isReader(e.manifest));
    const have = new Set(mine.map((e) => e.id));
    return [
      ...mine.map((e) => ({ id: e.id, manifest: e.manifest as Manifest & { reads: ReaderSpec } })),
      ...Object.values(BUNDLED)
        .filter((b) => isReader(b.manifest) && !have.has(b.manifest.id))
        .map((b) => ({ id: b.manifest.id, manifest: b.manifest as Manifest & { reads: ReaderSpec } })),
    ];
  }

  view(): MoveInView {
    const m = getMoveIn(this.d.sql);
    const order = ["chatgpt-export", "claude-export", "hermes", "openclaw"];
    const readers = this.readers()
      .map((r) => ({
        id: r.id,
        name: r.manifest.name,
        icon: r.manifest.icon ?? null,
        icon_invert: Boolean(r.manifest.icon_invert),
        reads: r.manifest.reads,
      }))
      .sort((a, b) => rank(order, a.id) - rank(order, b.id) || a.name.localeCompare(b.name));
    const phase: MoveInView["phase"] = !m ? "idle" : m.phase === "learning" && !this.#learning ? "paused" : m.phase;
    return {
      readers,
      phase,
      sources: m?.sources ?? [],
      gathered: gathered(this.d.sql),
      progress: m?.chunks ? { done: m.chunks.done.length, of: m.chunks.of, failed: Object.keys(m.chunks.failed).length } : null,
      read: m?.read ?? null,
      items: (m?.items ?? []).map(({ skill, was: _was, ...i }) => ({
        ...i,
        ...(skill ? { skill: { folder: skill.folder, files: skill.files.length, left_out: skill.left_out } } : {}),
      })),
      known: m?.known ?? 0,
      error: m?.error ?? null,
      started_at: m?.started_at ?? null,
    };
  }

  #changed(): void {
    this.d.changed(this.view());
  }

  /** The reader by id, installed (and on) the first time the owner moves in with it. */
  #reader(id: string): Installed & { manifest: Manifest & { reads: ReaderSpec } } {
    let e = getExt(this.d.sql, id);
    if (!e && BUNDLED[id] && isReader(BUNDLED[id]!.manifest)) e = install(this.d.sql, { id, source: "bundled", state: "on" });
    if (!e || !isReader(e.manifest)) throw new Error(`Atlas has no reader called ${id}.`);
    if (e.state !== "on") throw new Error(`${e.name} is turned off in Abilities → Services.`);
    return e as Installed & { manifest: Manifest & { reads: ReaderSpec } };
  }

  #busy(): string | null {
    const m = getMoveIn(this.d.sql);
    return m?.phase === "learning" && this.#learning ? "Atlas is still reading what you sent; this can join once it's done." : null;
  }

  /**
   * One file, or one part of a big one, from the app: its reader reads it in
   * the sandbox, and what it found joins what's gathered. Says what it found,
   * and the skills that came with the other assistant, so the app doesn't send them.
   */
  async read(o: {
    reader: string;
    path: string;
    part: number;
    text: string;
  }): Promise<{ ok: boolean; text: string; builtin_skills?: string[]; seen?: number; talks?: number; notes?: number }> {
    const busy = this.#busy();
    if (busy) return { ok: false, text: busy };
    let e;
    try {
      e = this.#reader(o.reader);
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    const path = cleanPath(o.path).slice(0, 400);
    if (!readerTakes(e.manifest.reads, path))
      return { ok: false, text: `${e.name} doesn't read ${path}: it takes ${e.manifest.reads.files.join(", ")}.` };
    let out: ReadOut;
    try {
      out = (await this.d.host.call<ReadOut | null>(e.id, "read", [{ path, text: o.text, part: o.part }], { ms: 60_000 })) ?? {};
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ at: "movein.read", reader: e.id, path, part: o.part, error: why }));
      const m = current(this.d.sql);
      m.error = `${e.name} couldn't read ${path}: ${why}`;
      saveMoveIn(this.d.sql, m);
      this.#changed();
      return { ok: false, text: m.error };
    }
    takeRead(this.d.sql, { id: e.id, name: e.name }, out);
    this.#changed();
    return {
      ok: true,
      text: "Read.",
      ...(out.builtin_skills?.length ? { builtin_skills: out.builtin_skills } : {}),
      seen: out.seen ?? out.talks?.length ?? 0,
      talks: out.talks?.length ?? 0,
      notes: out.notes?.length ?? 0,
    };
  }

  /**
   * A skill folder from the app, as it was: kept in R2 until the owner keeps
   * it, then installed unchanged. A skill that came with the other assistant,
   * or that has a name Atlas already uses, is listed but starts dropped, with why.
   */
  async skill(o: {
    reader: string;
    folder: string;
    files: Array<{ path: string; base64: string }>;
  }): Promise<{ ok: boolean; text: string }> {
    const busy = this.#busy();
    if (busy) return { ok: false, text: busy };
    let e;
    try {
      e = this.#reader(o.reader);
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    const bucket = this.d.bucket();
    if (!bucket) return { ok: false, text: "This deployment has no bucket to keep skill folders in, so skills can't move in." };
    const folder = cleanPath(o.folder).slice(0, 300);
    const files = new Map<string, Uint8Array>();
    const left_out: string[] = [];
    let total = 0;
    for (const f of o.files.slice(0, SKILL_FILES * 2)) {
      const p = cleanPath(f.path);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      } catch {
        left_out.push(p);
        continue;
      }
      // As a hub's skill: the folder as it is, under names Atlas can keep a file by, nothing too big.
      if (!keepable(p) || bytes.length > SKILL_FILE_BYTES || files.size >= SKILL_FILES) {
        left_out.push(p);
        continue;
      }
      total += bytes.length;
      if (total > SKILL_BYTES)
        return { ok: false, text: `The skill in ${folder} is over ${SKILL_BYTES / 1_000_000} MB, so it wasn't moved in.` };
      files.set(p, bytes);
    }
    const md = files.get("SKILL.md");
    if (!md) return { ok: false, text: `${folder} has no SKILL.md.` };
    let parsed;
    try {
      parsed = parseSkillMd(new TextDecoder().decode(md));
    } catch (err) {
      return { ok: false, text: `${folder}/SKILL.md doesn't read: ${err instanceof Error ? err.message : String(err)}` };
    }
    const m = current(this.d.sql);
    if (m.phase === "idle" || m.phase === "failed") m.phase = "reading";
    const base = folder.split("/").pop() ?? folder;
    const builtin = (m.builtin[e.id] ?? []).some((n) => n === parsed.name || n === base);
    const taken = findSkill(this.d.sql, parsed.name);
    const n = m.items.filter((i) => i.kind === "skill").length;
    const key = `movein/${m.id}/skills/${n}/`;
    for (const [p, bytes] of files) await bucket.put(`${key}${p}`, bytes);
    const item: MoveItem = {
      id: `mi_${m.id.slice(-6)}_s${n}`,
      kind: "skill",
      name: parsed.name.slice(0, 80),
      text: parsed.description.slice(0, 400),
      from: `${e.name} · ${folder}`,
      reader: e.id,
      sure: 1,
      state: builtin || taken ? "dropped" : "new",
      also: 0,
      ...(builtin ? { why: `Came with ${e.name}` } : taken ? { why: `You already have a skill called ${taken.name}` } : {}),
      skill: { key, folder, files: [...files.keys()], left_out },
    };
    m.items.push(item);
    const src = m.sources.find((s) => s.reader === e.id);
    if (src) src.skills += 1;
    else m.sources.push({ reader: e.id, name: e.name, files: 0, seen: 0, talks: 0, notes: 0, skills: 1 });
    saveMoveIn(this.d.sql, m);
    this.#changed();
    return { ok: true, text: `${parsed.name} is ready to keep.` };
  }

  /** Reads what was gathered, on the clock of this request's keep-alive: the review list fills as each chunk comes back. */
  learn(): { ok: boolean; text: string } {
    const m = getMoveIn(this.d.sql);
    if (!m) return { ok: false, text: "Nothing has been sent to read yet." };
    if (this.#learning) return { ok: true, text: "Already reading." };
    const chunks = chunksOf(this.d.sql);
    if (!chunks.length) {
      // Only skills, or nothing Atlas could use: straight to the review.
      m.phase = m.items.length ? "review" : "failed";
      m.error = m.items.length ? null : "There was nothing in it Atlas could read about you.";
      saveMoveIn(this.d.sql, m);
      this.#changed();
      return { ok: true, text: m.error ?? "Nothing to read; the skills are ready to keep." };
    }
    // Chunks are made the same way each time from what's gathered, so a reading picks up where a restart stopped it.
    if (!m.chunks || m.chunks.of !== chunks.length) m.chunks = { of: chunks.length, done: [], failed: {} };
    else m.chunks.failed = {};
    m.phase = "learning";
    m.error = null;
    saveMoveIn(this.d.sql, m);
    this.#learning = true;
    this.#changed();
    this.d.background(() => this.#learn(chunks));
    return { ok: true, text: "Reading." };
  }

  async #learn(chunks: ReturnType<typeof chunksOf>): Promise<void> {
    const sql = this.d.sql;
    const settings = readSettings(sql);
    const system = extractSystem(settings.owner_name);
    const run = startRun(sql, { actor: "atlas", trigger: "movein", surface: "none", role: "main" });
    const usage: Usage = { input: 0, output: 0 };
    let brain: string | null = null;
    let steps = 0;
    try {
      const todo = chunks.map((_, i) => i).filter((i) => !getMoveIn(sql)?.chunks?.done.includes(i));
      const next = () => todo.shift();
      const worker = async () => {
        for (let i = next(); i != null; i = next()) {
          const blocks = chunks[i]!;
          let text = "";
          try {
            const out = await this.#ask(system, chunkText(blocks));
            text = out.text;
            usage.input += out.usage?.input ?? 0;
            usage.output += out.usage?.output ?? 0;
            brain = out.brain;
            steps += 1;
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            console.error(JSON.stringify({ at: "movein.extract", chunk: i, error: why }));
            const m = getMoveIn(sql);
            if (!m?.chunks) return;
            m.chunks.failed[String(i)] = why.slice(0, 300);
            saveMoveIn(sql, m);
            this.#changed();
            continue;
          }
          const m = getMoveIn(sql);
          // The owner ended the move-in while this was reading.
          if (!m?.chunks) return;
          addFound(sql, m, parseFound(text, blocks));
          if (!m.chunks.done.includes(i)) m.chunks.done.push(i);
          saveMoveIn(sql, m);
          this.#changed();
        }
      };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length || 1) }, worker));
    } finally {
      this.#learning = false;
    }
    const m = getMoveIn(sql);
    if (!m?.chunks) {
      endRun(sql, run, "failed", steps, { error: "The move-in was ended before Atlas finished reading.", usage });
      return;
    }
    const failed = Object.values(m.chunks.failed);
    const read = { talks: 0, notes: 0 };
    for (const i of m.chunks.done) for (const b of chunks[i] ?? []) b.talk ? (read.talks += 1) : (read.notes += 1);
    m.read = { talks: read.talks, notes: read.notes, seen: m.sources.reduce((n, s) => n + s.seen, 0) };
    if (!m.chunks.done.length) {
      m.phase = m.items.length ? "review" : "failed";
      m.error = `No brain could read it. ${failed[0] ?? "None answered."}`;
    } else {
      m.phase = "review";
      m.error = failed.length
        ? `${failed.length} of ${m.chunks.of} parts couldn't be read (${failed[0]}). Try again to read just those.`
        : null;
    }
    saveMoveIn(sql, m);
    endRun(sql, run, m.chunks.done.length ? "replied" : "failed", steps, {
      ...(m.error ? { error: m.error } : {}),
      ...(brain ? { brain } : {}),
      usage,
      note: `Read ${m.chunks.done.length} of ${m.chunks.of} parts; found ${m.items.filter((i) => i.kind !== "skill").length} things to keep or drop.`,
    });
    this.#changed();
  }

  /** One extraction call, on the helpers' brains in order: no tools, its answer only read as values. */
  async #ask(system: string, text: string): Promise<{ text: string; usage?: Usage; brain: string }> {
    const chain = this.d.router.chain(chainFor(readSettings(this.d.sql), "helpers").chain);
    if (!chain.length) throw new Error("No brain is set up to read with.");
    const why: string[] = [];
    for (const brain of chain) {
      const at = Date.now();
      let first: number | null = null;
      let out = "";
      let usage: Usage | undefined;
      try {
        for await (const e of brain.stream({
          system,
          messages: [{ role: "user", content: text }],
          tools: [],
          effort: "low",
          maxOutputTokens: 3_000,
          signal: AbortSignal.timeout(120_000),
        })) {
          first ??= Date.now() - at;
          if (e.type === "text") out += e.text;
          if (e.type === "done") usage = e.usage;
        }
        this.d.router.markOk(brain, { ...(usage ? { usage } : {}), first_ms: first, total_ms: Date.now() - at });
        return { text: out, ...(usage ? { usage } : {}), brain: brainKey(brain) };
      } catch (err) {
        this.d.router.markFailed(brain, err);
        why.push(`${brainKey(brain)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(why.join("; "));
  }

  /** The owner keeps or drops items; kept ones become records, or skills installed as they were. */
  async decide(o: { ids: string[]; all?: boolean; keep: boolean }): Promise<{ ok: boolean; text: string }> {
    const m = getMoveIn(this.d.sql);
    if (!m) return { ok: false, text: "That move-in is over." };
    const picked = o.all ? m.items.filter((i) => i.state === "new") : m.items.filter((i) => o.ids.includes(i.id));
    const kept: MoveItem[] = [];
    const dropped: MoveItem[] = [];
    const problems: string[] = [];
    let skills = false;
    for (const i of picked) {
      try {
        if (o.keep) {
          if (i.state === "kept") continue;
          if (i.kind === "skill") {
            await this.#installSkill(i);
            skills = true;
          } else keepItem(this.d.sql, i);
          kept.push(i);
        } else {
          if (i.state === "dropped") continue;
          if (i.kind === "skill" && i.state === "kept" && i.record) {
            setSkillState(this.d.sql, i.record, "archived", "owner", `Dropped from what moved in from ${i.from}.`);
            skills = true;
          }
          dropItem(this.d.sql, i);
          dropped.push(i);
        }
      } catch (err) {
        problems.push(`${i.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    noteDecision(this.d.sql, m, kept, dropped);
    saveMoveIn(this.d.sql, m);
    this.d.recordsChanged();
    if (skills) this.d.skillsChanged();
    this.#changed();
    return problems.length
      ? { ok: false, text: problems.join(" ") }
      : { ok: true, text: o.keep ? `Kept ${kept.length}.` : `Dropped ${dropped.length}.` };
  }

  /** Installs a moved-in skill as it was: its SKILL.md read for the index, and its whole folder kept in R2 beside it. */
  async #installSkill(i: MoveItem): Promise<void> {
    const bucket = this.d.bucket();
    if (!bucket || !i.skill) throw new Error("its folder isn't there any more");
    const had = findSkill(this.d.sql, i.name);
    if (had && had.id !== i.record && had.state === "active")
      throw new Error(`there's already a skill called ${had.name}, so it wasn't put over it`);
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const p of i.skill.files) {
      const obj = await bucket.get(`${i.skill.key}${p}`);
      if (!obj) throw new Error(`its ${p} isn't there any more`);
      files.push({ path: p, bytes: new Uint8Array(await obj.arrayBuffer()) });
    }
    const md = files.find((f) => f.path === "SKILL.md");
    if (!md) throw new Error("it has no SKILL.md");
    const p = parseSkillMd(new TextDecoder().decode(md.bytes));
    const saved = saveSkill(this.d.sql, { ...p, by: "owner", note: `Moved in from ${i.from}.` });
    const skill = saved.skill;
    if (skill.state !== "active") setSkillState(this.d.sql, skill.id, "active", "owner", `Moved in again from ${i.from}.`);
    const kept: SkillFile[] = [];
    for (const f of files) {
      await bucket.put(skillFileKey(skill.id, f.path), f.bytes);
      if (f.path !== "SKILL.md") kept.push({ path: f.path, size: f.bytes.length });
    }
    setSkillFiles(this.d.sql, skill.id, kept);
    i.record = getSkill(this.d.sql, skill.id)!.id;
    i.state = "kept";
    delete i.why;
  }

  /** Done: what was kept stays; the review list, what was gathered and the skill folders waiting in R2 are let go. */
  async done(): Promise<void> {
    // A reading under way sees the move-in gone after its next chunk, and stops there.
    const prefixes = endMoveIn(this.d.sql);
    const bucket = this.d.bucket();
    if (bucket)
      for (const prefix of prefixes) {
        let cursor: string | undefined;
        do {
          const list = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
          if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
      }
    this.#changed();
  }
}
