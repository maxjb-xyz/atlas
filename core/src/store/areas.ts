// Areas (VISION §6): ongoing parts of the owner's life, as labels on log
// rows and records. Tagging is cheap and wrong guesses are cheap (rule 9):
// an area only changes context and convenience. What leaves Atlas is set
// per area by explicit settings, which arrive with the outbox in M2 and M5.

import { z } from "zod";
import { type Json, newId, parse, type Sql } from "./db";
import { append } from "./log";
import { getState, setState } from "./state";

export const AreaSettings = z.object({
  /** How Atlas talks in this area: "formal with clients", "relaxed". */
  tone: z.string().max(300).default(""),
});
export type AreaSettings = z.infer<typeof AreaSettings>;

export type AreaState = "active" | "dormant" | "archived";

export interface Area {
  id: string;
  name: string;
  about: string;
  state: AreaState;
  /** An index into the app's area palette. */
  color: number;
  settings: AreaSettings;
  created_at: number;
  updated_at: number;
  last_seen: number | null;
}

type RawArea = Omit<Area, "settings" | "state"> & { settings: string; state: string };

const fromRaw = (r: RawArea): Area => ({
  ...r,
  state: (["active", "dormant", "archived"].includes(r.state) ? r.state : "active") as AreaState,
  settings: AreaSettings.parse(parse(r.settings, {})),
});

/** How many colors the app has for areas; new areas take the next one. */
export const AREA_COLORS = 8;

export function listAreas(sql: Sql, opts: { all?: boolean } = {}): Area[] {
  return sql
    .exec<RawArea>(`SELECT * FROM areas ${opts.all ? "" : "WHERE state != 'archived'"} ORDER BY created_at`)
    .toArray()
    .map(fromRaw);
}

export function getArea(sql: Sql, id: string): Area | null {
  const r = sql.exec<RawArea>(`SELECT * FROM areas WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function areaByName(sql: Sql, name: string): Area | null {
  const r = sql.exec<RawArea>(`SELECT * FROM areas WHERE name = ?`, name.trim()).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function createArea(
  sql: Sql,
  a: { name: string; about?: string; by: "owner" | "atlas"; run_id?: string | null; reason?: string },
): Area {
  const existing = areaByName(sql, a.name);
  if (existing) {
    if (existing.state === "archived") return updateArea(sql, existing.id, { state: "active" }, a.by);
    return existing;
  }
  const id = newId("area");
  const now = Date.now();
  const color = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM areas`).one().n % AREA_COLORS;
  sql.exec(
    `INSERT INTO areas (id, name, about, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    a.name.trim().slice(0, 60),
    (a.about ?? "").slice(0, 500),
    color,
    now,
    now,
  );
  append(sql, {
    actor: a.by,
    kind: "area.change",
    run_id: a.run_id ?? null,
    body: { area_id: id, name: a.name, change: "created", ...(a.reason ? { reason: a.reason } : {}) },
  });
  return getArea(sql, id)!;
}

export interface AreaPatch {
  name?: string;
  about?: string;
  state?: AreaState;
  settings?: Partial<AreaSettings>;
}

export function updateArea(sql: Sql, id: string, patch: AreaPatch, by: "owner" | "atlas", extra: Record<string, Json> = {}): Area {
  const before = getArea(sql, id);
  if (!before) throw new Error(`There's no area ${id}.`);
  const settings = AreaSettings.parse({ ...before.settings, ...(patch.settings ?? {}) });
  const name = patch.name?.trim() || before.name;
  if (name.toLowerCase() !== before.name.toLowerCase() && areaByName(sql, name)) throw new Error(`There's already an area called ${name}.`);
  sql.exec(
    `UPDATE areas SET name = ?, about = ?, state = ?, settings = ?, updated_at = ? WHERE id = ?`,
    name.slice(0, 60),
    (patch.about ?? before.about).slice(0, 500),
    patch.state ?? before.state,
    JSON.stringify(settings),
    Date.now(),
    id,
  );
  append(sql, {
    actor: by,
    kind: "area.change",
    body: { area_id: id, name, change: "updated", before: { name: before.name, about: before.about, state: before.state }, ...extra },
  });
  return getArea(sql, id)!;
}

/** Folds one area into another: every tag and example moves, and the old one is archived. */
export function mergeAreas(sql: Sql, fromId: string, intoId: string, by: "owner" | "atlas"): Area {
  const from = getArea(sql, fromId);
  const into = getArea(sql, intoId);
  if (!from || !into || from.id === into.id) throw new Error("Pick two different areas to merge.");
  for (const table of ["log", "records"] as const) {
    const rows = sql.exec<{ id: string; areas: string }>(`SELECT id, areas FROM ${table} WHERE areas LIKE ?`, `%"${from.id}"%`).toArray();
    for (const r of rows) {
      const next = [...new Set(parse<string[]>(r.areas, []).map((a) => (a === from.id ? into.id : a)))];
      sql.exec(`UPDATE ${table} SET areas = ? WHERE id = ?`, JSON.stringify(next), r.id);
    }
  }
  sql.exec(`UPDATE area_examples SET area_id = ? WHERE area_id = ?`, into.id, from.id);
  updateArea(sql, from.id, { state: "archived" }, by, { merged_into: into.id });
  return into;
}

// --- tags ----------------------------------------------------------------------------

/** A tagged thing: a log row (`log:<id>`) or a record (`rec:<id>`). */
export type Tagged = `log:${string}` | `rec:${string}`;

export function tagsOf(sql: Sql, ref: Tagged): string[] {
  const [table, id] = ref.startsWith("log:") ? ["log", ref.slice(4)] : ["records", ref.slice(4)];
  const r = sql.exec<{ areas: string }>(`SELECT areas FROM ${table} WHERE id = ?`, id).toArray()[0];
  return r ? parse<string[]>(r.areas, []) : [];
}

export function setTags(sql: Sql, ref: Tagged, areas: string[]): void {
  const [table, id] = ref.startsWith("log:") ? ["log", ref.slice(4)] : ["records", ref.slice(4)];
  sql.exec(`UPDATE ${table} SET areas = ? WHERE id = ?`, JSON.stringify([...new Set(areas)]), id);
  if (table === "records") sql.exec(`UPDATE records SET tagged = 1 WHERE id = ?`, id);
  const now = Date.now();
  for (const a of areas) sql.exec(`UPDATE areas SET last_seen = ? WHERE id = ?`, now, a);
}

// --- examples (§6.3: corrections teach future tagging) ---------------------------------

export function addExample(sql: Sql, areaId: string, text: string, fits: boolean): void {
  sql.exec(`INSERT INTO area_examples (area_id, text, fits, at) VALUES (?, ?, ?, ?)`, areaId, text.slice(0, 300), fits ? 1 : 0, Date.now());
}

export function examples(sql: Sql, areaId: string, limit = 6): Array<{ text: string; fits: boolean }> {
  return sql
    .exec<{ text: string; fits: number }>(`SELECT text, fits FROM area_examples WHERE area_id = ? ORDER BY seq DESC LIMIT ?`, areaId, limit)
    .toArray()
    .map((r) => ({ text: r.text, fits: r.fits === 1 }));
}

// --- the scope switcher (§21.3) -----------------------------------------------------

/** The area the owner is focused on, or null for all areas. */
export function getScope(sql: Sql): string | null {
  const id = getState<string>(sql, "scope");
  return id && getArea(sql, id)?.state !== "archived" ? id : null;
}

export function setScope(sql: Sql, id: string | null): void {
  setState(sql, "scope", id);
}
