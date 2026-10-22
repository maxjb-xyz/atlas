// Skills (§9.3): know-how Atlas writes down and finds again, in the
// SKILL.md format (Agent Skills), so skills from Claude Code, Codex, Hermes
// and OpenClaw work unchanged. Each one's one-line description sits in the
// index every run sees; its body is read when it's needed. A skill is
// patched, not rewritten: every version is kept, and any one can be brought
// back. A skill can carry a quick check that runs in the workspace; a
// weekly pass re-runs the checks and flags broken ones. Skills nobody uses
// for a long while are archived, never deleted.

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

/** Skills unused this long are archived by the tidy-up (they stay searchable, out of the index). */
export const ARCHIVE_AFTER_MS = 120 * 86_400_000;

const fromRow = (r: Record<string, unknown>): Skill => ({
  ...(r as unknown as Skill),
  areas: parse<string[]>(String(r.areas ?? "[]"), []),
  checked: parse<Skill["checked"]>(String(r.checked ?? "null"), null),
});

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
    created_at: old?.created_at ?? now,
    updated_at: now,
  };
  sql.exec(
    `INSERT OR REPLACE INTO skills (id, name, description, body, "check", areas, made_by, state, version, uses, last_used, checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
