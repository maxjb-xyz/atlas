// Skills (§9.3): know-how Atlas writes down and finds again, in the
// SKILL.md format (Agent Skills), so skills from Claude Code, Codex, Hermes
// and OpenClaw work unchanged, folders and all. Each one's one-line
// description sits in the index every run sees; its body is read when it's
// needed. A skill is patched, not rewritten: a change replaces the passage
// that was wrong, every version is kept, and any one can be brought back. A
// new skill that reads like one Atlas already has is refused with that
// skill's name, so there's one skill per method. A skill can carry a quick
// check that runs in the workspace; a weekly pass re-runs the checks and
// flags broken ones. Skills nobody uses for a long while are archived,
// never deleted. Most skills are learned by a review after a conversation
// goes quiet (agent.ts), not mid-turn.

import { newId, parse, type Sql } from "./store/db";
import { append, type LogRow } from "./store/log";
import { type AgendaItem, createItem } from "./store/agenda";

export interface Skill {
  id: string;
  name: string;
  /** What it's for and when to use it, in a line: the index shows this. */
  description: string;
  /** The instructions, in Markdown (SKILL.md without its frontmatter). */
  body: string;
  /** A shell command, run in /workspace, that exits 0 when the skill still works. */
  check: string;
  areas: string[];
  made_by: "owner" | "atlas";
  state: "active" | "archived";
  version: number;
  uses: number;
  last_used: number | null;
  /** The last check: when, whether it passed, and what it printed when it didn't. */
  checked: { at: number; ok: boolean; output: string } | null;
  /** The files in its folder beside the SKILL.md (references/, scripts/, templates/, assets/), kept in R2. */
  files: SkillFile[];
  created_at: number;
  updated_at: number;
}

export interface SkillVersion {
  n: number;
  at: number;
  by: "owner" | "atlas";
  note: string;
  description: string;
  body: string;
  check: string;
}

export interface SkillFile {
  /** Inside the skill's folder: "scripts/fill.py", "references/fields.md". */
  path: string;
  size: number;
}

/** A skill's file in R2. */
export const skillFileKey = (id: string, path: string) => `skills/${id}/${path}`;

/** A folder's file path, as the standard lays a skill out. */
export const FILE_PATH = /^(references|scripts|templates|assets|examples)\/[A-Za-z0-9._\-/]{1,160}$/;

/**
 * How close two skills' meanings must be to count as the same method: a new
 * skill this close to one Atlas has is refused, and two this close are
 * offered to the review to merge.
 */
export const SAME_METHOD = 0.86;

/** Skills unused this long are archived by the tidy-up (they stay searchable, out of the index). */
export const ARCHIVE_AFTER_MS = 120 * 86_400_000;

const fromRow = (r: Record<string, unknown>): Skill => {
  const { vec: _vec, vec_model: _model, ...rest } = r;
  return {
    ...(rest as unknown as Skill),
    areas: parse<string[]>(String(r.areas ?? "[]"), []),
    checked: parse<Skill["checked"]>(String(r.checked ?? "null"), null),
    files: parse<SkillFile[]>(String(r.files ?? "[]"), []),
  };
};

export function listSkills(sql: Sql, o: { all?: boolean } = {}): Skill[] {
  return sql
    .exec(`SELECT * FROM skills ${o.all ? "" : "WHERE state = 'active'"} ORDER BY uses DESC, updated_at DESC`)
    .toArray()
    .map(fromRow);
}

export function getSkill(sql: Sql, id: string): Skill | null {
  const r = sql.exec(`SELECT * FROM skills WHERE id = ?`, id).toArray()[0];
  return r ? fromRow(r) : null;
}

export function findSkill(sql: Sql, nameOrId: string): Skill | null {
  const r = sql.exec(`SELECT * FROM skills WHERE id = ? OR lower(name) = lower(?) LIMIT 1`, nameOrId, slug(nameOrId)).toArray()[0];
  return r ? fromRow(r) : null;
}

export function skillVersions(sql: Sql, id: string): SkillVersion[] {
  return sql
    .exec(`SELECT n, at, by, note, description, body, "check" FROM skill_versions WHERE skill_id = ? ORDER BY n DESC`, id)
    .toArray() as unknown as SkillVersion[];
}

/** A skill's name as SKILL.md wants it: lowercase words joined by hyphens. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Saves a skill: a new one, or a new version of one with the same name
 * (patched, with a note on what changed). A version that changes nothing
 * isn't saved.
 */
export function saveSkill(
  sql: Sql,
  o: {
    name: string;
    description: string;
    body: string;
    check?: string;
    areas?: string[];
    by: "owner" | "atlas";
    note?: string;
    run_id?: string | null;
  },
): { skill: Skill; change: "made" | "patched" | "same"; row?: LogRow } {
  const name = slug(o.name);
  if (!name) throw new Error("A skill needs a name, like 'file-reimbursements'.");
  const description = o.description.replace(/\s+/g, " ").trim();
  if (description.length < 10) throw new Error("Describe what the skill is for and when to use it, in a sentence.");
  const body = o.body.trim();
  if (body.length < 20) throw new Error("A skill needs its steps: what to do, in order, and what went wrong along the way.");
  const check = (o.check ?? "").trim();
  const old = findSkill(sql, name);
  const now = Date.now();
  if (old && old.description === description && old.body === body && old.check === (o.check === undefined ? old.check : check))
    return { skill: old, change: "same" };
  const skill: Skill = {
    id: old?.id ?? newId("skl"),
    name,
    description,
    body,
    check: o.check === undefined && old ? old.check : check,
    areas: o.areas ?? old?.areas ?? [],
    made_by: old?.made_by ?? o.by,
    state: "active",
    version: (old?.version ?? 0) + 1,
    uses: old?.uses ?? 0,
    last_used: old?.last_used ?? null,
    checked: old && old.check === check ? old.checked : null,
    files: old?.files ?? [],
    created_at: old?.created_at ?? now,
    updated_at: now,
  };
  sql.exec(
    // An upsert, not a replace: a replace would drop the skill's files and its meaning's vector.
    `INSERT INTO skills (id, name, description, body, "check", areas, made_by, state, version, uses, last_used, checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, body = excluded.body,
       "check" = excluded."check", areas = excluded.areas, state = excluded.state, version = excluded.version,
       checked = excluded.checked, updated_at = excluded.updated_at,
       vec = CASE WHEN skills.description = excluded.description THEN skills.vec ELSE NULL END`,
    skill.id,
    skill.name,
    skill.description,
    skill.body,
    skill.check,
    JSON.stringify(skill.areas),
    skill.made_by,
    skill.state,
    skill.version,
    skill.uses,
    skill.last_used,
    JSON.stringify(skill.checked),
    skill.created_at,
    skill.updated_at,
  );
  const note = o.note?.trim().slice(0, 300) || (old ? "Changed." : "Learned.");
  sql.exec(
    `INSERT INTO skill_versions (skill_id, n, at, by, note, description, body, "check") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    skill.id,
    skill.version,
    now,
    o.by,
    note,
    skill.description,
    skill.body,
    skill.check,
  );
  const row = append(sql, {
    actor: o.by,
    kind: "skill.change",
    run_id: o.run_id ?? null,
    body: { change: old ? "patched" : "made", id: skill.id, name, version: skill.version, note },
  });
  return { skill, change: old ? "patched" : "made", row };
}

/**
 * Replaces passages in a skill's body: each `old` must appear exactly once,
 * so a patch changes only what was wrong. Says plainly when one doesn't fit.
 */
export function patchBody(body: string, edits: Array<{ old: string; new: string }>): string {
  let out = body;
  for (const e of edits) {
    const n = e.old ? out.split(e.old).length - 1 : 0;
    if (n === 0) throw new Error(`The skill doesn't say "${e.old.slice(0, 80)}". Read it with skill_read and quote the passage exactly.`);
    if (n > 1) throw new Error(`"${e.old.slice(0, 80)}" appears ${n} times in the skill. Quote more around it, so it's one place.`);
    out = out.replace(e.old, () => e.new);
  }
  return out;
}

/** The text a skill's meaning is taken from: its name and what it's for. */
export const meaningOf = (s: { name: string; description: string }) => `${s.name.replace(/-/g, " ")}: ${s.description}`;

export function setSkillVec(sql: Sql, id: string, model: string, vec: Float32Array): void {
  sql.exec(`UPDATE skills SET vec = ?, vec_model = ? WHERE id = ?`, vec.buffer as ArrayBuffer, model, id);
}

/** Active skills whose meaning wasn't taken with this model yet. */
export function skillsWithoutVec(sql: Sql, model: string): Skill[] {
  return sql.exec(`SELECT * FROM skills WHERE state = 'active' AND (vec IS NULL OR vec_model IS NOT ?)`, model).toArray().map(fromRow);
}

function vecs(sql: Sql, model: string): Array<{ skill: Skill; vec: Float32Array }> {
  return sql
    .exec(`SELECT * FROM skills WHERE state = 'active' AND vec IS NOT NULL AND vec_model = ?`, model)
    .toArray()
    .map((r) => ({ skill: fromRow(r), vec: new Float32Array(r.vec as ArrayBuffer) }));
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!;
  return s;
};

/** The active skill closest in meaning to `vec` (vectors are unit length), and how close. */
export function nearestSkill(sql: Sql, vec: Float32Array, model: string, except?: string): { skill: Skill; score: number } | null {
  let best: { skill: Skill; score: number } | null = null;
  for (const v of vecs(sql, model)) {
    if (v.skill.id === except) continue;
    const score = dot(vec, v.vec);
    if (!best || score > best.score) best = { skill: v.skill, score };
  }
  return best;
}

/** Pairs of active skills that read like the same method, for the review to merge. */
export function samePairs(sql: Sql, model: string, threshold = SAME_METHOD): Array<[Skill, Skill]> {
  const all = vecs(sql, model);
  const out: Array<[Skill, Skill]> = [];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) if (dot(all[i]!.vec, all[j]!.vec) >= threshold) out.push([all[i]!.skill, all[j]!.skill]);
  return out;
}

export function setSkillFiles(sql: Sql, id: string, files: SkillFile[]): void {
  sql.exec(`UPDATE skills SET files = ?, updated_at = ? WHERE id = ?`, JSON.stringify(files), Date.now(), id);
}

/**
 * Whether learning works (§9.3: measured): how many skills there are, how
 * many Atlas learned in the last 30 days, and how often its own were opened.
 */
export function skillStats(sql: Sql, now = Date.now()): { skills: number; learned_month: number; opened: number } {
  const r = sql
    .exec<{ skills: number; learned: number | null; opened: number | null }>(
      `SELECT COUNT(*) AS skills,
              SUM(CASE WHEN made_by = 'atlas' AND created_at >= ? THEN 1 ELSE 0 END) AS learned,
              SUM(CASE WHEN made_by = 'atlas' THEN uses ELSE 0 END) AS opened
       FROM skills WHERE state = 'active'`,
      now - 30 * 86_400_000,
    )
    .one();
  return { skills: r.skills, learned_month: r.learned ?? 0, opened: r.opened ?? 0 };
}

/** Brings back an older version as a new one (history only grows). */
export function restoreSkill(sql: Sql, id: string, n: number, by: "owner" | "atlas", note = `Back to version ${n}.`): LogRow | null {
  const s = getSkill(sql, id);
  const v = skillVersions(sql, id).find((x) => x.n === n);
  if (!s || !v) return null;
  return saveSkill(sql, { name: s.name, description: v.description, body: v.body, check: v.check, by, note }).row ?? null;
}

export function setSkillState(sql: Sql, id: string, state: "active" | "archived", by: "owner" | "atlas", why = ""): LogRow | null {
  const s = getSkill(sql, id);
  if (!s || s.state === state) return null;
  sql.exec(`UPDATE skills SET state = ?, updated_at = ? WHERE id = ?`, state, Date.now(), id);
  return append(sql, { actor: by, kind: "skill.change", body: { change: state, id, name: s.name, ...(why ? { note: why } : {}) } });
}

/** A skill was read to be used: counted, so used ones rank first (§9.3: found again). */
export function noteUse(sql: Sql, id: string): void {
  sql.exec(`UPDATE skills SET uses = uses + 1, last_used = ? WHERE id = ?`, Date.now(), id);
}

export function noteCheck(sql: Sql, id: string, r: { ok: boolean; output: string }): void {
  sql.exec(`UPDATE skills SET checked = ? WHERE id = ?`, JSON.stringify({ at: Date.now(), ok: r.ok, output: r.output.slice(-2_000) }), id);
}

/** Archives skills nobody has used for a long while. Returns their names. Never deletes. */
export function tidySkills(sql: Sql, now = Date.now()): string[] {
  const stale = listSkills(sql).filter((s) => (s.last_used ?? s.updated_at) < now - ARCHIVE_AFTER_MS);
  for (const s of stale) setSkillState(sql, s.id, "archived", "atlas", "Unused for four months.");
  return stale.map((s) => s.name);
}

// --- SKILL.md ------------------------------------------------------------------------------

/** The frontmatter's simple values: `key: value` lines, with quotes allowed. Nested blocks are kept as text. */
function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  // metadata: { atlas-check: ... } is written as an indented block.
  const check = /^\s+atlas-check:\s*(.*)$/m.exec(text)?.[1]?.trim();
  if (check) out["atlas-check"] = check.replace(/^["']|["']$/g, "");
  return out;
}

/** Reads a SKILL.md: its name, description and body, and Atlas's check if it has one. */
export function parseSkillMd(md: string): { name: string; description: string; body: string; check: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md.replace(/^﻿/, "").trimStart());
  if (!m) throw new Error("A SKILL.md starts with frontmatter between --- lines, with at least name and description.");
  const fm = frontmatter(m[1]!);
  if (!fm.name || !fm.description) throw new Error("The SKILL.md's frontmatter needs a name and a description.");
  return { name: fm.name, description: fm.description, body: m[2]!.trim(), check: fm["atlas-check"] ?? "" };
}

/** Writes a skill as a SKILL.md other agents can read. */
export function skillMd(s: Pick<Skill, "name" | "description" | "body" | "check">): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    "---",
    `name: ${s.name}`,
    `description: ${q(s.description)}`,
    ...(s.check ? ["metadata:", `  atlas-check: ${q(s.check)}`] : []),
    "---",
    "",
    s.body,
    "",
  ].join("\n");
}

/** How often skills' checks run. */
export const CHECK_EVERY_MS = 7 * 86_400_000;

/**
 * The weekly pass that re-runs skills' checks, on the one clock (§4.3).
 * Made once there's a skill with a check; returns it when it was just made,
 * so the caller puts it on the clock.
 */
export function ensureSkillChecks(sql: Sql, now = Date.now()): AgendaItem | null {
  if (!listSkills(sql).some((s) => s.check)) return null;
  const open = sql.exec(`SELECT id FROM agenda WHERE kind = 'skills' AND state IN ('scheduled', 'running') LIMIT 1`).toArray()[0];
  if (open) return null;
  return createItem(sql, { kind: "skills", title: "Check skills", due_at: now + CHECK_EVERY_MS, source: { via: "skills" } });
}
