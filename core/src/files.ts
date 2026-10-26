// Files (§21.7): things Atlas makes that you download or open elsewhere, a
// spreadsheet, a PDF, a script. The bytes live in R2; this agent keeps what
// each file is (its name, type, size, who made it) beside pages, and every
// change is a row in the log. Atlas makes text files itself, and copies
// anything else out of the workspace.

import { newId, parse, type Sql } from "./store/db";
import { append } from "./store/log";
import type { FileRow, FileStagePage } from "./stage";

export type { FileRow };

/** The types Atlas names by extension, so a download opens in the right app. */
const TYPES: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  ics: "text/calendar",
  xml: "application/xml",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sh: "text/x-shellscript",
  css: "text/css",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Whether a file is text Atlas and the stage can read. */
export const isText = (type: string) => type.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(type);

/** Where a file's bytes live in R2. */
export const keyOf = (f: Pick<FileRow, "id">) => `files/${f.id}`;

/** The most a file may be: R2 takes more, but Atlas's files are documents, not archives. */
export const MAX_FILE_BYTES = 50_000_000;

const fromRow = (r: Record<string, unknown>): FileRow => ({ ...r, areas: parse<string[]>(r.areas as string, []) }) as unknown as FileRow;

export function listFiles(sql: Sql): FileRow[] {
  return sql.exec(`SELECT * FROM files ORDER BY updated_at DESC`).toArray().map(fromRow);
}

export function getFile(sql: Sql, id: string): FileRow | null {
  const r = sql.exec(`SELECT * FROM files WHERE id = ?`, id).toArray()[0];
  return r ? fromRow(r) : null;
}

export function findFile(sql: Sql, nameOrId: string): FileRow | null {
  return (
    getFile(sql, nameOrId) ??
    sql
      .exec(`SELECT * FROM files WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1`, nameOrId.trim())
      .toArray()
      .map(fromRow)[0] ??
    null
  );
}

/** A file's name, cleaned: no folders, nothing a download would trip on. */
export function cleanName(name: string): string {
  const n = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim()
    .slice(0, 120);
  if (!n || n.startsWith("."))
    throw new Error(`"${name}" isn't a file name Atlas can use. Give it a name with an extension, like "plan.csv".`);
  return n;
}

/**
 * Saves a file to R2 and remembers it. A file with the same name is
 * replaced in place (same id), and the log says so.
 */
export async function saveFile(
  sql: Sql,
  bucket: R2Bucket,
  o: {
    name: string;
    body: ArrayBuffer | Uint8Array | string;
    type?: string;
    made_by: "owner" | "atlas";
    note?: string;
    run_id?: string | null;
  },
): Promise<{ file: FileRow; replaced: boolean }> {
  const name = cleanName(o.name);
  const bytes =
    typeof o.body === "string" ? new TextEncoder().encode(o.body) : o.body instanceof Uint8Array ? o.body : new Uint8Array(o.body);
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new Error(`${name} is ${Math.round(bytes.byteLength / 1e6)} MB; files can be at most 50 MB.`);
  const type = o.type ?? typeOf(name);
  const old = findFile(sql, name);
  const now = Date.now();
  const file: FileRow = {
    id: old?.id ?? newId("file"),
    name,
    // A new version of a file keeps the areas it was in.
    areas: old?.areas ?? [],
    type,
    size: bytes.byteLength,
    made_by: o.made_by,
    note: o.note?.trim().slice(0, 300) ?? "",
    run_id: o.run_id ?? null,
    created_at: old?.created_at ?? now,
    updated_at: now,
  };
  try {
    await bucket.put(keyOf(file), bytes, { httpMetadata: { contentType: type } });
  } catch (err) {
    throw new Error(`R2 wouldn't keep ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  sql.exec(
    `INSERT OR REPLACE INTO files (id, name, type, size, made_by, note, run_id, created_at, updated_at, areas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    file.id,
    file.name,
    file.type,
    file.size,
    file.made_by,
    file.note,
    file.run_id,
    file.created_at,
    file.updated_at,
    JSON.stringify(file.areas),
  );
  append(sql, {
    actor: o.made_by,
    kind: "file.change",
    run_id: o.run_id ?? null,
    body: { change: old ? "replaced" : "made", id: file.id, name, size: file.size, ...(file.note ? { note: file.note } : {}) },
  });
  return { file, replaced: Boolean(old) };
}

/** Deletes every object under a prefix in R2 ("skills/sk1/", "jobs/owner/"), a page of a thousand at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    n += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

export async function deleteFile(sql: Sql, bucket: R2Bucket, id: string, by: "owner" | "atlas"): Promise<FileRow | null> {
  const f = getFile(sql, id);
  if (!f) return null;
  await bucket.delete(keyOf(f));
  sql.exec(`DELETE FROM files WHERE id = ?`, id);
  append(sql, { actor: by, kind: "file.change", body: { change: "deleted", id, name: f.name } });
  return f;
}

/** A text file's words, from `start`, at most `chars`. */
export async function readText(bucket: R2Bucket, f: FileRow, start = 0, chars = 16_000): Promise<{ text: string; length: number }> {
  const obj = await bucket.get(keyOf(f));
  if (!obj) throw new Error(`${f.name} is missing from R2.`);
  const all = await obj.text();
  return { text: all.slice(start, start + chars), length: all.length };
}

/** Rows of a CSV or TSV (quotes, doubled quotes and line breaks in quotes), at most `max`. */
export function parseTable(text: string, tab: boolean, max = 200): { rows: string[][]; more: boolean } {
  const sep = tab ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > max) return { rows: rows.slice(0, max), more: true };
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return { rows, more: false };
}

/** What a file's view shows (§21.6): its details, a download link, and a look inside when that's possible. */
export async function filePage(sql: Sql, bucket: R2Bucket | null, id: string): Promise<FileStagePage | { kind: "missing"; why: string }> {
  const f = getFile(sql, id);
  if (!f) return { kind: "missing", why: "That file was deleted." };
  const file = {
    id: f.id,
    name: f.name,
    type: f.type,
    size: f.size,
    made_by: f.made_by,
    note: f.note,
    updated_at: f.updated_at,
    url: `/api/files/${f.id}`,
  };
  if (f.type.startsWith("image/") && f.type !== "image/svg+xml") return { kind: "file", file, preview: { kind: "image" } };
  if (f.type === "application/pdf") return { kind: "file", file, preview: { kind: "pdf" } };
  if (!bucket || !isText(f.type)) return { kind: "file", file, preview: { kind: "none" } };
  try {
    const { text, length } = await readText(bucket, f, 0, 60_000);
    if (f.type === "text/csv" || f.type === "text/tab-separated-values") {
      const t = parseTable(text, f.type !== "text/csv");
      const [columns = [], ...rows] = t.rows;
      return { kind: "file", file, preview: { kind: "table", columns, rows, more: t.more || length > text.length } };
    }
    return { kind: "file", file, preview: { kind: "text", text, more: length > text.length } };
  } catch (err) {
    console.error(JSON.stringify({ at: "file.preview", id, error: err instanceof Error ? err.message : String(err) }));
    return { kind: "file", file, preview: { kind: "none" } };
  }
}
