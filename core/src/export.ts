// Take a copy of everything (VISION §20, §23.4): the person agent's data as
// one archive of open formats, a tar.gz the owner downloads. Every table as
// JSON (the log, records, areas, agenda, automations, pages, skills...), the
// settings, pages as Markdown, skills as SKILL.md folders, and the files in
// Library and the workspace's kept copy from R2. Secrets are left out: keys,
// tokens, sign-ins and the vault's values stay in Atlas, and the archive
// lists their names so it says plainly what isn't there. The archive is
// written as it's read, so a big one never sits in memory or in R2.

import type { Sql } from "./store/db";
import { keyOf, listFiles } from "./files";
import { listPages, pageVersion } from "./pages";
import { listSkills, skillFileKey, skillMd } from "./skills";
import { readSettings } from "./store/settings";
import { vault, vaultView } from "./vault";

const enc = new TextEncoder();

// --- tar ------------------------------------------------------------------------------------------------

/** One pax record ("%d key=value\n"), whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = enc.encode(body).length;
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

function header(name: string, size: number, mtime: number, type: "0" | "x"): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, max: number) => h.set(enc.encode(s).subarray(0, max), off);
  const octal = (n: number, width: number) =>
    `${Math.max(0, Math.floor(n))
      .toString(8)
      .padStart(width - 1, "0")}\0`;
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime / 1000, 12), 136, 12);
  put("        ", 148, 8);
  h[156] = type.charCodeAt(0);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/**
 * Writes a tar archive (POSIX ustar, with a pax header for a long or
 * non-ASCII name) into a stream, one file at a time, waiting for the reader.
 */
export class TarWriter {
  constructor(private readonly w: WritableStreamDefaultWriter<Uint8Array>) {}

  async #write(bytes: Uint8Array): Promise<void> {
    await this.w.ready;
    await this.w.write(bytes);
  }

  async #pad(size: number): Promise<void> {
    const rest = (512 - (size % 512)) % 512;
    if (rest) await this.#write(new Uint8Array(rest));
  }

  /** A file whose bytes are here, or a stream of exactly `size` bytes (cut or filled with zeros if it isn't). */
  async file(path: string, body: Uint8Array | string | ReadableStream<Uint8Array>, size?: number, mtime = Date.now()): Promise<void> {
    const bytes = typeof body === "string" ? enc.encode(body) : body;
    const n = bytes instanceof Uint8Array ? bytes.length : (size ?? 0);
    const plain = /^[\x20-\x7e]+$/.test(path) && path.length <= 100;
    if (!plain) {
      const pax = enc.encode(paxRecord("path", path));
      await this.#write(header("././@PaxHeader", pax.length, mtime, "x"));
      await this.#write(pax);
      await this.#pad(pax.length);
    }
    await this.#write(header(plain ? path : path.replace(/[^\x20-\x7e]/g, "_").slice(-100), n, mtime, "0"));
    if (bytes instanceof Uint8Array) {
      await this.#write(bytes);
    } else {
      let sent = 0;
      const reader = bytes.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = value.subarray(0, Math.max(0, n - sent));
        if (take.length) await this.#write(take);
        sent += take.length;
      }
      if (sent < n) await this.#write(new Uint8Array(n - sent));
    }
    await this.#pad(n);
  }

  async end(): Promise<void> {
    await this.#write(new Uint8Array(1024));
    await this.w.close();
  }
}

// --- what goes in ----------------------------------------------------------------------------------------

/** State that is a credential or a sign-in in flight: it opens something, so it stays in Atlas like a secret. */
export const STATE_LEFT_OUT = [
  "sessions",
  "passkey_challenges",
  "code_tries",
  "call_tokens",
  "chatgpt_client",
  "channel_code",
  "node_pairings",
  "push_devices",
  "ext_signins",
];
/** Columns that are a credential: an extension's address key. */
const COLUMNS_LEFT_OUT: Record<string, string[]> = { extensions: ["key"] };
/** A table's rows go in files of about this much JSON, so a long log never sits in memory whole. */
const PART_BYTES = 4_000_000;

/** The tables that go in: Atlas's own, without the secrets, the search index (remade from memory) or the SDK's internals. */
export function exportedTables(sql: Sql): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       AND name NOT LIKE 'cf\\_%' ESCAPE '\\' AND name NOT LIKE 'memory\\_fts%' ESCAPE '\\' AND name != 'secrets' ORDER BY name`,
    )
    .toArray()
    .map((r) => r.name);
}

/** A row as JSON: JSON kept in text columns is read back, vectors are left out (Atlas remakes them from the text). */
function readable(table: string, row: Record<string, SqlStorageValue>): Record<string, unknown> | null {
  if (table === "state" && STATE_LEFT_OUT.includes(String(row.key))) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__rowid" || COLUMNS_LEFT_OUT[table]?.includes(k)) continue;
    if (v instanceof ArrayBuffer) out[k] = null;
    else if (typeof v === "string" && /^[[{]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}

/** A name that's safe as a file name everywhere, kept recognisable. */
export function safeName(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return s || "untitled";
}

/** Names made unique within a folder: "notes.md", "notes (2).md". */
function namer() {
  const seen = new Set<string>();
  return (name: string) => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let out = name;
    for (let i = 2; seen.has(out.toLowerCase()); i++) out = `${stem} (${i})${ext}`;
    seen.add(out.toLowerCase());
    return out;
  };
}

export interface ExportSummary {
  files: number;
  tables: Record<string, number>;
  /** What couldn't be put in, each in the words of what failed. */
  problems: string[];
}

export interface ExportSource {
  sql: Sql;
  bucket: R2Bucket | null;
  /** The workspace's kept copy in R2 (§9.1), for the owner's Atlas: workspace/owner.tgz. */
  workspaceKey: string | null;
  /** Whose Atlas this is, for the README. */
  who: string;
  version: string;
  /** Secret names held (never their values). */
  secrets: string[];
  /** Connected MCP servers, by name and address only (their sign-ins are secrets). */
  mcp: Array<{ name: string; server_url: string }>;
}

const README = (o: { who: string; at: string; version: string; problems: string[] }) =>
  [
    `# A copy of ${o.who}`,
    "",
    `Taken ${o.at}, from Atlas ${o.version}.`,
    "",
    "## What's in it",
    "",
    "- `tables/`: everything Atlas keeps, one JSON file per table (a long table in parts: `log.json`, `log.2.json`...). `log` is every message, action and delivery; `records` the people, places and facts Atlas knows; `areas`, `agenda`, `automations`, `pages` and `page_versions`, `skills` and `skill_versions`, `files`, `state` and the rest are what their names say.",
    "- `settings.json`: your settings, as Atlas settings shows them.",
    "- `pages/`: each page's newest version, as Markdown. Every version is in `tables/page_versions.json`.",
    "- `skills/`: each skill as a folder with its SKILL.md and its files.",
    "- `files/`: the files in Library.",
    "- `workspace/workspace.tgz`: the workspace's kept copy of /workspace, when there is one.",
    "- `vault.json`: your vault's entries by name, kind and site, without their values.",
    "- `mcp-servers.json`: the MCP servers Atlas is connected to, by name and address.",
    "",
    "## What's left out, and why",
    "",
    "- **Secrets:** your keys, tokens, sign-ins and the vault's passwords, cards and codes. They open your accounts, so they never leave Atlas, not even in a copy for you. `secrets.json` lists the names of the ones Atlas holds.",
    "- **Sign-ins in progress:** this browser's and your devices' sessions, pairing codes and push addresses.",
    "- **What Atlas remakes by itself:** the vectors behind memory and skills (they come back from the text) and the search index.",
    "- **Members' Atlases:** each member's Atlas is theirs, and they take their own copy.",
    "",
    "Dates are milliseconds since 1970 (UTC), the way JavaScript's Date takes them.",
    ...(o.problems.length ? ["", "## What couldn't be copied", "", ...o.problems.map((p) => `- ${p}`)] : []),
    "",
  ].join("\n");

/**
 * Writes the archive into `tar`, under the folder `root`. Each part that fails
 * is noted and skipped, so one missing file doesn't cost the whole copy;
 * the notes go in README.md, written last.
 */
export async function writeExport(tar: TarWriter, src: ExportSource, root: string): Promise<ExportSummary> {
  const { sql, bucket } = src;
  const problems: string[] = [];
  const tables: Record<string, number> = {};
  let files = 0;
  const put = async (path: string, body: Uint8Array | string | ReadableStream<Uint8Array>, size?: number) => {
    await tar.file(`${root}/${path}`, body, size);
    files++;
  };

  // Every table, a part at a time.
  for (const t of exportedTables(sql)) {
    let part = 1;
    let rows: string[] = [];
    let bytes = 0;
    let n = 0;
    const flush = async () => {
      await put(`tables/${t}${part > 1 ? `.${part}` : ""}.json`, `[\n${rows.join(",\n")}\n]\n`);
      part++;
      rows = [];
      bytes = 0;
    };
    let after = -Infinity;
    for (;;) {
      const batch = sql
        .exec<Record<string, SqlStorageValue>>(`SELECT rowid AS __rowid, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 500`, after)
        .toArray();
      if (!batch.length) break;
      for (const r of batch) {
        after = Number(r.__rowid);
        const row = readable(t, r);
        if (!row) continue;
        const text = JSON.stringify(row);
        rows.push(text);
        bytes += text.length;
        n++;
        if (bytes >= PART_BYTES) await flush();
      }
    }
    if (rows.length || part === 1) await flush();
    tables[t] = n;
  }

  await put("settings.json", JSON.stringify(readSettings(sql), null, 2));
  await put("vault.json", JSON.stringify(vault(sql).map(vaultView), null, 2));
  await put("secrets.json", JSON.stringify({ held: src.secrets, note: "Names only: the values stay in Atlas." }, null, 2));
  await put("mcp-servers.json", JSON.stringify(src.mcp, null, 2));

  const pageName = namer();
  for (const p of listPages(sql)) {
    const v = pageVersion(sql, p.id);
    if (v) await put(`pages/${pageName(`${safeName(p.name)}.md`)}`, v.body);
  }

  const skillName = namer();
  for (const s of listSkills(sql, { all: true })) {
    const dir = `skills/${skillName(safeName(s.name))}`;
    await put(`${dir}/SKILL.md`, skillMd(s));
    for (const f of s.files) {
      const obj = bucket ? await bucket.get(skillFileKey(s.id, f.path)).catch((e: Error) => e) : null;
      if (obj instanceof Error) problems.push(`${s.name}'s ${f.path}: R2 said: ${obj.message}`);
      else if (!obj) problems.push(`${s.name}'s ${f.path} isn't in the files store any more.`);
      else await put(`${dir}/${f.path.split("/").map(safeName).join("/")}`, obj.body, obj.size);
    }
  }

  const fileName = namer();
  for (const f of listFiles(sql)) {
    const obj = bucket ? await bucket.get(keyOf(f)).catch((e: Error) => e) : null;
    if (obj instanceof Error) problems.push(`${f.name}: R2 said: ${obj.message}`);
    else if (!obj) problems.push(`${f.name} isn't in the files store any more (${keyOf(f)}).`);
    else await put(`files/${fileName(safeName(f.name))}`, obj.body, obj.size);
  }

  if (bucket && src.workspaceKey) {
    const obj = await bucket.get(src.workspaceKey).catch((e: Error) => e);
    if (obj instanceof Error) problems.push(`The workspace's kept copy: R2 said: ${obj.message}`);
    else if (obj) await put("workspace/workspace.tgz", obj.body, obj.size);
  }
  if (!bucket)
    problems.push("This deployment has no files store (the FILES bucket), so Library's files and skills' files aren't in the copy.");

  await put("README.md", README({ who: src.who, at: new Date().toISOString(), version: src.version, problems }));
  return { files, tables, problems };
}
