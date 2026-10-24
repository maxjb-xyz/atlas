// Services: one catalog (VISION §17). The owner sees one card per service,
// whatever is underneath: an extension, a vendor's own MCP server, skills.
// The catalog comes from an index, a JSON file in a git repo that lists
// services with their parts, each piece of code pinned to a commit and a
// sha256 of its bytes. Each release carries a snapshot of Atlas's own index
// (services.gen.ts, from index/services.json), so the catalog works when
// GitHub doesn't; a look on the one clock fetches a newer one once a day,
// and the owner can add other indexes by their address. Nothing runs on a
// server for it: a listing is a reviewed change to the file.
//
// This file is the format and its checks, the merged catalog, and what's
// kept about it. What the agent does with it (fetching, installing,
// updating, the cards) is in agent/services.ts.

import { z } from "zod";
import type { Manifest } from "../../extensions/sdk";
import { SNAPSHOT } from "./services.gen";
import { type AgendaItem, createItem, upcoming } from "./store/agenda";
import type { Sql } from "./store/db";
import { getState, setState } from "./store/state";

/** Atlas's own index: the file in its repo that each release also carries as a snapshot. */
export const DEFAULT_INDEX = "https://raw.githubusercontent.com/maxjb-xyz/atlas/main/index/services.json";

/** How often the index is looked at again. */
export const INDEX_EVERY_MS = 24 * 3_600_000;

/** The most an index, an extension's code or a skill's file may be. */
export const MAX_INDEX_BYTES = 2_000_000;
export const MAX_CODE_BYTES = 500_000;
export const MAX_FILE_BYTES = 1_000_000;

const COMMIT = /^[0-9a-f]{40}$/;

/** An address pinned to a commit: https, with a path segment that's a full 40-character commit hash. */
export function pinned(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.search && !u.hash && u.pathname.split("/").some((p) => COMMIT.test(p));
  } catch {
    return false;
  }
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
}

// --- the format ------------------------------------------------------------------------------------------

const Id = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "lowercase letters, digits and dashes");
const Sha = z.string().regex(/^[0-9a-f]{64}$/, "a sha256, as 64 lowercase hex characters");
const Pinned = z.string().max(500).refine(pinned, "an https address pinned to a commit (a 40-character commit hash in its path)");
const Https = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith("https://"), "an https address");
/** A logo: a small SVG or PNG as a data URI, which the app shows as an image (never as markup). */
export const Icon = z
  .string()
  .max(24_000)
  .regex(/^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+/=]+$/, "an SVG or PNG data URI, base64");
const Line = (n: number) => z.string().trim().min(1).max(n);
const Host = z.string().min(3).max(120);

/** The extension part: one that ships with Atlas, by its id, or code pinned to a commit with its hash and what it may reach and hold. */
const ExtensionPart = z.union([
  z.object({ bundled: Id }).strict(),
  z
    .object({
      id: Id,
      code: Pinned,
      sha256: Sha,
      /** The only hosts its manifest may name: the code is refused if it asks for more. */
      hosts: z.array(Host).max(20),
      /** The only secrets it may hold, by name. */
      secrets: z
        .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
        .max(20)
        .default([]),
    })
    .strict(),
]);

/** A vendor's own MCP server (only the vendor's: there's no code to pin) and how to sign in to it. */
const McpPart = z.object({ url: Https, signin: z.enum(["oauth", "token", "either"]) }).strict();

/** A skill folder (SKILL.md and its files), pinned like code: its folder's address at a commit, and each file's hash. */
const SkillPart = z
  .object({
    name: Line(80),
    base: Pinned.refine((u) => u.endsWith("/"), "a folder's address, ending in /"),
    files: z
      .record(z.string().regex(/^[A-Za-z0-9._\-/]{1,200}$/), Sha)
      .refine((f) => "SKILL.md" in f, "a skill folder has a SKILL.md")
      .refine((f) => Object.keys(f).length <= 40, "at most 40 files"),
  })
  .strict();

/**
 * The one setup a card offers, when one covers every part (§17): a key the
 * owner pastes once (kept as the extension's `secret`, and sent to the MCP
 * server as its bearer token when `mcp`); a sign-in (the MCP server's own,
 * or the extension's); nothing to set up; or each part set up on its own.
 */
const Setup = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("key"),
      label: Line(80),
      help: Line(400),
      secret: z
        .string()
        .regex(/^[a-z0-9_]{1,40}$/)
        .optional(),
      mcp: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal("signin"), via: z.enum(["mcp", "extension"]) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("each") }).strict(),
]);

export const Service = z
  .object({
    id: Id,
    name: Line(60),
    /** "work", "notes", "mail", "chat", "calendar", "location", "maps", "weather", "search", "coding", "money", "home". */
    category: z.string().regex(/^[a-z][a-z-]{1,30}$/),
    about: Line(300),
    icon: Icon.optional(),
    icon_invert: z.boolean().optional(),
    /** What Atlas hears from it, in a line for Simple: "Issues assigned to you, mentions and comments". */
    hears: Line(200).optional(),
    /** What it can do there, in a line: "Create and update issues, comment". */
    does: Line(200).optional(),
    /** What it costs while it's on, when that isn't nothing. */
    cost: Line(200).optional(),
    setup: Setup.default({ kind: "none" }),
    extension: ExtensionPart.optional(),
    mcp: McpPart.optional(),
    skills: z.array(SkillPart).max(20).default([]),
  })
  .strict()
  .refine((s) => s.extension || s.mcp || s.skills.length, "a service needs at least one part");

export type Service = z.infer<typeof Service>;
export type ExtensionPart = z.infer<typeof ExtensionPart>;
export type PinnedExtension = Extract<ExtensionPart, { code: string }>;
export type SkillPart = z.infer<typeof SkillPart>;

const IndexHead = z.object({
  atlas_index: z.literal(1),
  name: Line(60),
  about: Line(400).optional(),
  /** When it last changed, YYYY-MM-DD: the newer of the snapshot and the fetched copy wins. */
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  services: z.array(z.unknown()).max(500),
});

export interface ServiceIndex {
  name: string;
  about: string | null;
  updated: string;
  services: Service[];
}

/**
 * Reads an index. A service that doesn't fit the format is left out and
 * named in `problems`, so one bad listing doesn't hide the rest; an index
 * whose head doesn't fit is refused whole.
 */
export function readIndex(raw: unknown): { index: ServiceIndex; problems: string[] } {
  const head = IndexHead.safeParse(raw);
  if (!head.success)
    throw new Error(`It isn't a services index: ${head.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  const problems: string[] = [];
  const services: Service[] = [];
  const seen = new Set<string>();
  for (const [n, s] of head.data.services.entries()) {
    const p = Service.safeParse(s);
    const id = (s as { id?: unknown } | null)?.id;
    const who = typeof id === "string" ? id : `service ${n + 1}`;
    if (!p.success) {
      problems.push(`${who}: ${p.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")}`);
      continue;
    }
    if (seen.has(p.data.id)) {
      problems.push(`${who}: listed twice; the first is kept.`);
      continue;
    }
    seen.add(p.data.id);
    services.push(p.data);
  }
  return {
    index: { name: head.data.name, about: head.data.about ?? null, updated: head.data.updated, services },
    problems,
  };
}

/** This release's snapshot of Atlas's own index. */
export const snapshot = (): ServiceIndex => (snap ??= readIndex(SNAPSHOT).index);
let snap: ServiceIndex | null = null;

// --- what's kept ------------------------------------------------------------------------------------------

export interface IndexLook {
  /** When it was last fetched, worked or not, and when it last worked. */
  at: number;
  ok_at: number | null;
  error: string | null;
  index: ServiceIndex | null;
  problems: string[];
}

/** The indexes the catalog reads, Atlas's own first. */
export const indexSources = (sql: Sql): string[] => [DEFAULT_INDEX, ...(getState<string[]>(sql, "service_indexes") ?? [])];

export function addIndex(sql: Sql, url: string): void {
  if (!/^https:\/\//.test(url)) throw new Error("An index's address starts with https://.");
  const all = getState<string[]>(sql, "service_indexes") ?? [];
  if (url === DEFAULT_INDEX || all.includes(url)) return;
  if (all.length >= 10) throw new Error("Atlas reads at most ten indexes besides its own; remove one first.");
  setState(sql, "service_indexes", [...all, url]);
}

export function removeIndex(sql: Sql, url: string): void {
  setState(
    sql,
    "service_indexes",
    (getState<string[]>(sql, "service_indexes") ?? []).filter((u) => u !== url),
  );
  const cache = indexLooks(sql);
  delete cache[url];
  setState(sql, "service_index_cache", cache);
}

export const indexLooks = (sql: Sql): Record<string, IndexLook> => getState<Record<string, IndexLook>>(sql, "service_index_cache") ?? {};

export function noteIndexLook(sql: Sql, url: string, o: { index: ServiceIndex; problems: string[] } | { error: string }): void {
  const all = indexLooks(sql);
  const was = all[url];
  const now = Date.now();
  all[url] =
    "error" in o
      ? { at: now, ok_at: was?.ok_at ?? null, error: o.error.slice(0, 500), index: was?.index ?? null, problems: was?.problems ?? [] }
      : { at: now, ok_at: now, error: null, index: o.index, problems: o.problems.slice(0, 20) };
  setState(sql, "service_index_cache", all);
}

/** A service as the catalog has it: its listing, and which index it came from. */
export interface Listed extends Service {
  index: string;
  /** It came from this release's snapshot, not a fetched copy. */
  snapshot: boolean;
}

/**
 * The catalog: Atlas's own index (the fetched copy, or the release's
 * snapshot when that's newer or nothing was fetched), then each index the
 * owner added, in order. A service's id is taken by the first index that
 * lists it, so another index can't take over one Atlas's own lists. Only
 * Atlas's own index may list an extension that ships with Atlas: another
 * one pairing GitHub's extension with its own MCP address and one key would
 * send the owner's GitHub token to that address.
 */
export function catalog(sql: Sql): Listed[] {
  const looks = indexLooks(sql);
  const own = looks[DEFAULT_INDEX]?.index;
  const snap = snapshot();
  const base = own && own.updated >= snap.updated ? { index: own, snapshot: false } : { index: snap, snapshot: true };
  const out = new Map<string, Listed>();
  for (const s of base.index.services) out.set(s.id, { ...s, index: DEFAULT_INDEX, snapshot: base.snapshot });
  for (const url of indexSources(sql).slice(1)) {
    for (const s of looks[url]?.index?.services ?? []) {
      if (out.has(s.id) || (s.extension && "bundled" in s.extension)) continue;
      out.set(s.id, { ...s, index: url, snapshot: false });
    }
  }
  return [...out.values()];
}

/** Where an installed extension's code came from: the service and index that listed it, and the pin it was installed at. */
export interface Pin {
  service: string;
  index: string;
  code: string;
  sha256: string;
  version: string;
  at: number;
}

export const pins = (sql: Sql): Record<string, Pin> => getState<Record<string, Pin>>(sql, "service_pins") ?? {};

export function setPin(sql: Sql, ext: string, pin: Pin | null): void {
  const all = pins(sql);
  if (pin) all[ext] = pin;
  else delete all[ext];
  setState(sql, "service_pins", all);
}

/** An update that would reach or hold more than before: kept until the owner says yes to it. */
export interface PendingUpdate {
  service: string;
  index: string;
  code: string;
  sha256: string;
  version: string;
  /** What it would add: hosts it would reach, and secrets it would hold. */
  widens: { hosts: string[]; secrets: string[]; tools?: string[] };
  at: number;
}

export const pendingUpdates = (sql: Sql): Record<string, PendingUpdate> =>
  getState<Record<string, PendingUpdate>>(sql, "service_updates") ?? {};

export function setPending(sql: Sql, ext: string, u: PendingUpdate | null): void {
  const all = pendingUpdates(sql);
  if (u) all[ext] = u;
  else delete all[ext];
  setState(sql, "service_updates", all);
}

// --- what an extension can touch -------------------------------------------------------------------------

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Every host an extension's manifest lets it reach: its own, git's, and a coding agent's model. */
export function reachOf(m: Manifest): string[] {
  const all = [...m.hosts, ...(m.git?.hosts ?? []), ...(m.agent ? [host(m.agent.model.url)] : [])];
  return [...new Set(all.map((h) => h.toLowerCase().replace(/^\*\./, "")).filter(Boolean))].sort();
}

/** Every secret it may hold, by name, including a sign-in's. */
export function holdsOf(m: Manifest): string[] {
  const all = [...(m.secrets ?? []).map((s) => s.name), ...(m.signin ? ["client_secret", "access_token", "refresh_token"] : [])];
  return [...new Set(all)].sort();
}

/**
 * What a new manifest would reach, hold or do that the old one doesn't:
 * hosts, secrets, and tools that are new or declare another kind, or a new
 * thing it provides. Any of them waits for the owner's OK.
 */
export function widening(before: Manifest, after: Manifest): { hosts: string[]; secrets: string[]; tools: string[] } {
  const had = reachOf(before);
  // A host the old one covered (itself or as a parent domain) isn't new.
  const covered = (h: string) => had.some((x) => h === x || h.endsWith(`.${x}`));
  const held = new Set(holdsOf(before));
  const was = new Map((before.tools ?? []).map((t) => [t.name, `${t.kind}:${t.undo ?? ""}`]));
  const tools = [
    ...(after.tools ?? []).filter((t) => was.get(t.name) !== `${t.kind}:${t.undo ?? ""}`).map((t) => `${t.name} (${t.kind})`),
    ...after.provides.filter((p) => !before.provides.includes(p)).map((p) => `provides ${p}`),
  ];
  return { hosts: reachOf(after).filter((h) => !covered(h)), secrets: holdsOf(after).filter((s) => !held.has(s)), tools };
}

/** Whether a manifest stays inside what its listing says it may reach and hold. */
export function outside(m: Manifest, part: PinnedExtension): string | null {
  const listed = part.hosts.map((h) => h.toLowerCase().replace(/^\*\./, ""));
  const extra = reachOf(m).filter((h) => !listed.some((x) => h === x || h.endsWith(`.${x}`)));
  const allowed = new Set(part.secrets);
  const more = holdsOf(m).filter((s) => !allowed.has(s));
  if (!extra.length && !more.length) return null;
  return [
    extra.length ? `reaches ${extra.join(", ")}, which its listing doesn't name` : "",
    more.length ? `holds ${more.join(", ")}, which its listing doesn't name` : "",
  ]
    .filter(Boolean)
    .join(", and ");
}

// --- fetching ----------------------------------------------------------------------------------------------

/**
 * Fetches a file for the catalog: an index, an extension's code, a skill's
 * file. Fails in the host's own words, with the status, and never follows
 * a redirect away from https.
 */
export async function fetchBytes(f: typeof fetch, url: string, max: number): Promise<Uint8Array> {
  const h = host(url);
  if (!url.startsWith("https://")) throw new Error(`Atlas fetches catalog files over https only, and ${url.split("?")[0]} isn't.`);
  let res: Response;
  try {
    res = await f(url, { headers: { accept: "application/json, text/plain, */*" }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(`Couldn't reach ${h}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.url && !res.url.startsWith("https://")) throw new Error(`${h} sent Atlas to ${res.url.split("?")[0]}, which isn't https.`);
  if (!res.ok) {
    const words = (await res.text().catch(() => ""))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    throw new Error(`${h} answered ${res.status}${words ? `: ${words}` : ""}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new Error(`${h} sent ${bytes.length} bytes, more than the ${max} Atlas takes for it.`);
  return bytes;
}

/** Fetches a pinned file and checks it's the one its listing hashed. */
export async function fetchPinned(f: typeof fetch, url: string, sha256: string, max: number): Promise<Uint8Array> {
  if (!pinned(url)) throw new Error(`${url} isn't pinned to a commit, so Atlas won't install from it.`);
  const bytes = await fetchBytes(f, url, max);
  const got = await sha256Hex(bytes);
  if (got !== sha256)
    throw new Error(
      `What ${host(url)} sent for ${url.split("/").pop()} doesn't match its listing's hash (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…), so nothing was installed.`,
    );
  return bytes;
}

// --- the daily look on the clock --------------------------------------------------------------------------

/** The index's look on the clock: one item, once a day; `soon` puts it a minute out (the first start). */
export function armIndex(sql: Sql, now = Date.now(), soon = false): AgendaItem | null {
  const open = upcoming(sql, 300).find((i) => i.kind === "index" && (i.state === "scheduled" || i.state === "running"));
  if (open) return null;
  const last = indexLooks(sql)[DEFAULT_INDEX]?.at ?? 0;
  const due = soon && !last ? now + 60_000 : Math.max(now + 60_000, last + INDEX_EVERY_MS);
  return createItem(sql, { kind: "index", title: "Look for a newer services index", due_at: due, source: { via: "services" } });
}
