// Pages (VISION §21.7): a stage view you keep. A page is text with stage
// views in it, kept in versions in Atlas's own storage. Area, person and
// automation views inside a page point at what Atlas knows, so they stay
// current; lists, tables, drafts, plans and the text stay as they were kept
// until the owner or Atlas changes them, and each change is a new version
// saying what changed. The body is Markdown, with each view as a fenced
// block whose info string is `view` and whose content is the view's JSON.

import { newId, type Sql } from "./store/db";
import { append, type LogRow } from "./store/log";
import type { PageSummary } from "./protocol";
import { StageView } from "./stage";

export interface Page {
  id: string;
  name: string;
  made_by: "owner" | "atlas";
  created_at: number;
  updated_at: number;
  /** The newest version's number, from 1. */
  version: number;
}

export type PageVersion = {
  n: number;
  at: number;
  by: "owner" | "atlas";
  body: string;
  /** What changed, in a few words. */
  note: string;
};

/** A page's body in parts: text, and the views kept in it. A block that doesn't read as a view stays as text, so nothing is lost. */
export type Segment = { kind: "text"; text: string } | { kind: "view"; view: StageView };

const FENCE = /^```view[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

export function segments(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(FENCE)) {
    const text = body.slice(last, m.index).trim();
    if (text) out.push({ kind: "text", text });
    let view: StageView | null = null;
    try {
      const parsed = StageView.safeParse(JSON.parse(m[1]!));
      if (parsed.success && parsed.data.kind !== "page") view = parsed.data;
    } catch {
      // Not JSON: kept as text below.
    }
    out.push(view ? { kind: "view", view } : { kind: "text", text: m[0] });
    last = m.index! + m[0].length;
  }
  const tail = body.slice(last).trim();
  if (tail) out.push({ kind: "text", text: tail });
  return out;
}

/** A view as the fenced block a page body holds. */
export const viewBlock = (v: StageView) => "```view\n" + JSON.stringify(v) + "\n```";

export function bodyOf(parts: Segment[]): string {
  return parts.map((s) => (s.kind === "text" ? s.text.trim() : viewBlock(s.view))).join("\n\n");
}

type Raw = { id: string; name: string; made_by: string; created_at: number; updated_at: number; version: number };
const fromRaw = (r: Raw): Page => ({ ...r, made_by: r.made_by === "owner" ? "owner" : "atlas" });

export function getPage(sql: Sql, id: string): Page | null {
  const r = sql.exec<Raw>(`SELECT * FROM pages WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

export function listPages(sql: Sql): Page[] {
  return sql.exec<Raw>(`SELECT * FROM pages ORDER BY updated_at DESC`).toArray().map(fromRaw);
}

export function findPage(sql: Sql, nameOrId: string): Page | null {
  const want = nameOrId.trim().toLowerCase();
  return getPage(sql, nameOrId.trim()) ?? listPages(sql).find((p) => p.name.toLowerCase() === want) ?? null;
}

/** One version of a page: the newest when `n` is left out. */
export function pageVersion(sql: Sql, id: string, n?: number): PageVersion | null {
  const r = sql
    .exec<PageVersion>(
      n == null
        ? `SELECT n, at, by, body, note FROM page_versions WHERE page_id = ? ORDER BY n DESC LIMIT 1`
        : `SELECT n, at, by, body, note FROM page_versions WHERE page_id = ? AND n = ?`,
      ...(n == null ? [id] : [id, n]),
    )
    .toArray()[0];
  return r ? { ...r, by: r.by === "owner" ? "owner" : "atlas" } : null;
}

export function pageVersions(sql: Sql, id: string): Array<Omit<PageVersion, "body">> {
  return sql
    .exec<Omit<PageVersion, "body">>(`SELECT n, at, by, note FROM page_versions WHERE page_id = ? ORDER BY n DESC LIMIT 100`, id)
    .toArray();
}

/**
 * Makes a page, or a new version of one (pass its id). A version that
 * changes nothing isn't saved. Returns the page and the log row for History.
 */
export function savePage(
  sql: Sql,
  o: { id?: string; name: string; body: string; note: string; by: "owner" | "atlas"; undo_of?: string },
): { page: Page; version: number; row: LogRow | null } {
  const name = o.name.trim().slice(0, 80);
  if (!name) throw new Error("A page needs a name.");
  const old = o.id ? getPage(sql, o.id) : null;
  if (o.id && !old) throw new Error("That page isn't there any more.");
  const clash = listPages(sql).find((p) => p.id !== old?.id && p.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`There's already a page called ${clash.name}. Change that one, or pick another name.`);
  const body = o.body.trim();
  if (body.length > 60_000) throw new Error("That page is too long: keep it under 60,000 characters.");
  const now = Date.now();
  if (old) {
    const last = pageVersion(sql, old.id);
    if (last && last.body === body && old.name === name) return { page: old, version: old.version, row: null };
  }
  const id = old?.id ?? newId("pg");
  const n = (old?.version ?? 0) + 1;
  if (old) sql.exec(`UPDATE pages SET name = ?, version = ?, updated_at = ? WHERE id = ?`, name, n, now, id);
  else
    sql.exec(`INSERT INTO pages (id, name, made_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)`, id, name, o.by, now, now);
  const note = o.note.trim().slice(0, 300) || (old ? "Changed" : "Made");
  sql.exec(`INSERT INTO page_versions (page_id, n, at, by, body, note) VALUES (?, ?, ?, ?, ?, ?)`, id, n, now, o.by, body, note);
  const row = append(sql, {
    actor: o.by,
    kind: "page.change",
    body: { page_id: id, name, version: n, change: old ? "changed" : "made", note, ...(o.undo_of ? { undo_of: o.undo_of } : {}) },
  });
  return { page: getPage(sql, id)!, version: n, row };
}

/** Library's list: each page's name, its first words and the kinds of view in it. */
export function pageSummaries(sql: Sql): PageSummary[] {
  return listPages(sql).map((p) => {
    const parts = segments(pageVersion(sql, p.id)?.body ?? "");
    const text = parts.find((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")?.text ?? "";
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      updated_at: p.updated_at,
      made_by: p.made_by,
      preview: text
        .replace(/[#*_`>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
      views: parts.filter((s) => s.kind === "view").map((s) => (s as Extract<Segment, { kind: "view" }>).view.kind),
    };
  });
}

/** Deletes a page and its versions. History keeps that it was there, by name. */
export function deletePage(sql: Sql, id: string, by: "owner" | "atlas", undo_of?: string): LogRow | null {
  const p = getPage(sql, id);
  if (!p) return null;
  sql.exec(`DELETE FROM page_versions WHERE page_id = ?`, id);
  sql.exec(`DELETE FROM pages WHERE id = ?`, id);
  return append(sql, {
    actor: by,
    kind: "page.change",
    body: { page_id: id, name: p.name, change: "deleted", ...(undo_of ? { undo_of } : {}) },
  });
}
