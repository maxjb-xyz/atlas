// Updates (VISION §23.2): each release is built once into a bundle (the
// Worker and the app) attached to its GitHub release, with release.json
// saying what's in it. Atlas looks at the releases once a day; Update
// uploads the bundle as a new version of the owner's own Worker through
// Cloudflare's API (an assets upload session for the app's files, a version
// upload with the bindings restated and the secrets inherited, then a
// deployment of that version to all traffic), and Roll back deploys the
// version before. Each step keeps Cloudflare's own words. A release that
// changes Atlas's Durable Objects can't ride in a version and is refused
// here, with what to do instead. The data only grows (§23.2), so rolling
// back the code never touches it.

import { CloudflareError, cf } from "./atlasmail";
import { fetchBytes, sha256Hex } from "./services";
import { createItem, type AgendaItem, upcoming } from "./store/agenda";
import { MIGRATIONS, type Sql } from "./store/db";
import { getState, setState } from "./store/state";
import type { UpdateRun } from "./protocol";

/** Atlas's releases, newest first. The repo is public, so no token is needed. */
export const RELEASES_URL = "https://api.github.com/repos/maxjb-xyz/atlas/releases?per_page=10";
export const BUNDLE_ASSET = "atlas-release.tar.gz";
export const MANIFEST_ASSET = "release.json";
export const UPDATE_EVERY_MS = 24 * 3_600_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_BUNDLE_BYTES = 100_000_000;
/** Cloudflare's code for a rollback to a version from before a secret changed: it needs `force`. */
export const SECRET_CHANGED = 10220;
/** How long a deployment may take to show up as the running version before it's called failed. */
export const DEPLOY_WAIT_MS = 15 * 60_000;

/** What Cloudflare's "Create token" page needs to make the updates token: Workers Scripts, edit, on the account. */
export function updateTokenLink(): string {
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify([{ key: "workers_scripts", type: "edit" }]),
    accountId: "*",
    zoneId: "all",
    name: "Atlas updates",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${q.toString()}`;
}

// --- what a release is -------------------------------------------------------------------------------------

/** A binding as Cloudflare's upload metadata takes it. */
export interface ApiBinding {
  type: string;
  name: string;
  [k: string]: unknown;
}

/** release.json, as scripts/release.mjs writes it. */
export interface ReleaseManifest {
  atlas_release: number;
  version: string;
  commit: string;
  schema: number;
  classes: string[];
  compatibility_date: string;
  /** What a version upload needs, beyond the files. */
  worker?: {
    main_module: string;
    compatibility_flags: string[];
    /** The Durable Object migrations' tags, in order. */
    migrations: string[];
    containers: Array<{ class_name: string }>;
    assets: { binding: string; config: Record<string, unknown> };
    bindings: ApiBinding[];
  };
  /** Each file in the bundle (worker/…, assets/…) and its SHA-256. */
  files: Record<string, string>;
}

export interface Release {
  tag: string;
  name: string;
  notes: string;
  published_at: number;
  url: string;
  bundle_url: string | null;
  manifest_url: string | null;
  manifest: ReleaseManifest | null;
  manifest_error: string | null;
}

/** Which Atlas is running: the app's build (its version and commit) and the Worker version Cloudflare runs. */
export interface Running {
  version: string;
  commit: string | null;
  /** From the version metadata binding; null when there's none (before the binding, or in dev). */
  version_id: string | null;
}

/** Which Worker is this Atlas: found from the token, by the version it's running. */
export interface Target {
  account_id: string;
  script: string;
}

export type { UpdateRun, UpdateStep as Step } from "./protocol";

export interface UpdatesState {
  looked_at: number | null;
  look_error: string | null;
  releases: Release[];
  target: Target | null;
  /** Why the newest release can't be installed from here, when it can't: set by the look and before updating. */
  blocked: { tag: string; text: string } | null;
  last: UpdateRun | null;
  /** The version that ran before the last update, for Roll back. */
  previous: { version_id: string; label: string } | null;
  /** What Atlas deployed last. */
  installed: { version_id: string; label: string; at: number } | null;
  /** A version Atlas didn't deploy that replaced one it did (Workers Builds after a push, or a deploy by hand). */
  foreign: { version_id: string; seen_at: number; source: string | null; replaced: string } | null;
}

export const updatesState = (sql: Sql): UpdatesState => ({
  looked_at: null,
  look_error: null,
  releases: [],
  target: null,
  blocked: null,
  last: null,
  previous: null,
  installed: null,
  foreign: null,
  ...(getState<Partial<UpdatesState>>(sql, "updates") ?? {}),
});

export function saveUpdates(sql: Sql, patch: Partial<UpdatesState>): UpdatesState {
  const next = { ...updatesState(sql), ...patch };
  setState(sql, "updates", next);
  return next;
}

// --- versions ----------------------------------------------------------------------------------------------

interface Parsed {
  nums: [number, number, number];
  pre: string | null;
  /** Commits past the tag, from `git describe` ("v1.2.0-3-gabc1234"). */
  ahead: number;
}

export function parseVersion(v: string): Parsed | null {
  const d = /-(\d+)-g[0-9a-f]+(?:-dirty)?$/.exec(v.trim());
  const base = d ? v.trim().slice(0, d.index) : v.trim().replace(/-dirty$/, "");
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(base);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] ?? null, ahead: Number(d?.[1] ?? 0) };
}

/**
 * Whether a release is newer than what's running. The same commit never is.
 * A build that isn't from a release (a commit, "dev") takes any release.
 */
export function isNewer(release: Pick<Release, "tag" | "manifest">, running: Running): boolean {
  if (running.commit && release.manifest?.commit && release.manifest.commit.startsWith(running.commit)) return false;
  if (release.tag === running.version) return false;
  const r = parseVersion(release.tag);
  const n = parseVersion(running.version);
  if (!n) return true;
  if (!r) return false;
  for (let i = 0; i < 3; i++) if (r.nums[i] !== n.nums[i]) return r.nums[i]! > n.nums[i]!;
  if (n.ahead > 0) return false;
  if (r.pre === n.pre) return false;
  if (!r.pre) return true;
  if (!n.pre) return false;
  return r.pre > n.pre;
}

// --- the daily look ----------------------------------------------------------------------------------------

/** The releases, newest first, without drafts and pre-releases. Fails in GitHub's own words, with the status. */
export async function fetchReleases(f: typeof fetch): Promise<Release[]> {
  let res: Response;
  try {
    res = await f(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Atlas", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Couldn't reach api.github.com: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const said = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : "";
    throw new Error(`api.github.com answered ${res.status}${said ? `: ${said}` : ""}`);
  }
  if (!Array.isArray(body)) throw new Error("api.github.com sent something that isn't a list of releases.");
  type Gh = {
    tag_name?: string;
    name?: string | null;
    body?: string | null;
    draft?: boolean;
    prerelease?: boolean;
    published_at?: string | null;
    html_url?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const asset = (r: Gh, name: string) => r.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
  return (body as Gh[])
    .filter((r) => !r.draft && !r.prerelease && r.tag_name && r.published_at)
    .map((r) => ({
      tag: r.tag_name!,
      name: r.name?.trim() || r.tag_name!,
      notes: (r.body ?? "").slice(0, 20_000),
      published_at: Date.parse(r.published_at!),
      url: r.html_url ?? "",
      bundle_url: asset(r, BUNDLE_ASSET),
      manifest_url: asset(r, MANIFEST_ASSET),
      manifest: null,
      manifest_error: null,
    }))
    .sort((a, b) => b.published_at - a.published_at)
    .slice(0, 5);
}

/** Reads release.json, or says what's wrong with it. */
export function readManifest(bytes: Uint8Array): ReleaseManifest {
  let m: ReleaseManifest;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
  } catch {
    throw new Error("The release's release.json isn't JSON.");
  }
  if (m?.atlas_release !== 1 || typeof m.version !== "string" || typeof m.schema !== "number" || !m.files || typeof m.files !== "object")
    throw new Error("The release's release.json isn't one Atlas can read.");
  return m;
}

export async function fetchManifest(f: typeof fetch, r: Release): Promise<{ manifest: ReleaseManifest; bytes: Uint8Array }> {
  if (!r.manifest_url) throw new Error(`${r.tag} has no ${MANIFEST_ASSET} attached, so it wasn't built for updates from the app.`);
  const bytes = await fetchBytes(f, r.manifest_url, MAX_MANIFEST_BYTES);
  return { manifest: readManifest(bytes), bytes };
}

/** The look on the clock: one item, once a day; `soon` puts it a minute out (the first start). */
export function armUpdates(sql: Sql, now = Date.now(), soon = false): AgendaItem | null {
  const open = upcoming(sql, 300).find((i) => i.kind === "updates" && (i.state === "scheduled" || i.state === "running"));
  if (open) return null;
  const last = updatesState(sql).looked_at ?? 0;
  const due = soon && !last ? now + 60_000 : Math.max(now + 60_000, last + UPDATE_EVERY_MS);
  return createItem(sql, { kind: "updates", title: "Look for a new Atlas release", due_at: due, source: { via: "updates" } });
}

// --- Cloudflare: which Worker, and what it runs ---------------------------------------------------------------

interface Deployment {
  id: string;
  created_on?: string;
  source?: string;
  versions: Array<{ version_id: string; percentage: number }>;
  annotations?: Record<string, string>;
}

export interface VersionDetail {
  id: string;
  number?: number;
  metadata?: { source?: string; created_on?: string; author_email?: string };
  annotations?: Record<string, string>;
  resources?: {
    bindings?: ApiBinding[];
    script_runtime?: { migration_tag?: string; containers?: unknown; compatibility_date?: string };
  };
}

const scriptPath = (t: Target) => `/accounts/${t.account_id}/workers/scripts/${encodeURIComponent(t.script)}`;

export async function deployments(f: typeof fetch, token: string, t: Target): Promise<Deployment[]> {
  const out = await cf<{ deployments?: Deployment[] }>(f, token, `${scriptPath(t)}/deployments`);
  return out?.deployments ?? [];
}

/** The version serving all traffic in a deployment (or the most of it). */
const stableOf = (d: Deployment | undefined) =>
  d ? [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id : undefined;

export async function versionDetail(f: typeof fetch, token: string, t: Target, id: string): Promise<VersionDetail> {
  return cf<VersionDetail>(f, token, `${scriptPath(t)}/versions/${id}`);
}

/**
 * Finds this Atlas's Worker from a token: the script, in an account the
 * token can see, whose deployment runs this very version. Without the
 * version metadata binding, a script named like the Worker's address, or
 * "atlas", when there's just one.
 */
export async function findTarget(f: typeof fetch, token: string, running: Running, hint: string | null): Promise<Target> {
  const accounts = await cf<Array<{ id: string; name?: string }>>(f, token, `/accounts?per_page=50`);
  if (!accounts?.length)
    throw new CloudflareError(
      "The token can't see any Cloudflare account. Make it with Account · Workers Scripts · Edit on the account Atlas is in.",
      403,
    );
  const likely = [hint, "atlas"].filter((x): x is string => Boolean(x));
  const problems: string[] = [];
  let checked = 0;
  for (const a of accounts) {
    let scripts: Array<{ id: string }>;
    try {
      scripts = await cf<Array<{ id: string }>>(f, token, `/accounts/${a.id}/workers/scripts`);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const names = scripts.map((s) => s.id).sort((x, y) => Number(likely.includes(y)) - Number(likely.includes(x)));
    if (!running.version_id) {
      const named = names.filter((n) => likely.includes(n));
      if (named.length) return { account_id: a.id, script: named[0]! };
      continue;
    }
    for (const script of names) {
      if (checked++ >= 40) break;
      const t = { account_id: a.id, script };
      const ds = await deployments(f, token, t).catch(() => []);
      if (ds.some((d) => d.versions.some((v) => v.version_id === running.version_id))) return t;
    }
  }
  throw new CloudflareError(
    `None of the Workers this token can see is running this Atlas${running.version_id ? ` (version ${running.version_id.slice(0, 8)})` : ""}. Make the token on the account Atlas is in.${problems.length ? ` ${problems[0]}` : ""}`,
    404,
  );
}

/** What runs now: the deployment's version, its bindings, and the migration tag Cloudflare applied last. */
export async function current(f: typeof fetch, token: string, t: Target) {
  const ds = await deployments(f, token, t);
  const id = stableOf(ds[0]);
  if (!id) throw new CloudflareError(`Cloudflare lists no deployment for ${t.script}.`, 404);
  const version = await versionDetail(f, token, t, id);
  let migration_tag = version.resources?.script_runtime?.migration_tag ?? null;
  if (!migration_tag) {
    const scripts = await cf<Array<{ id: string; migration_tag?: string }>>(f, token, `/accounts/${t.account_id}/workers/scripts`).catch(
      () => [],
    );
    migration_tag = scripts.find((s) => s.id === t.script)?.migration_tag ?? null;
  }
  return { deployments: ds, version_id: id, version, migration_tag };
}

/** Binding kinds a version can add by itself: nothing to make in the account first. */
const ADDABLE = new Set(["ai", "browser", "worker_loader", "version_metadata", "assets", "plain_text", "json"]);

/**
 * Why a release can't go in as a version, or null. A new Durable Object
 * class or migration needs a full deploy (Cloudflare applies migrations only
 * on a script upload, and nothing rolls back past one); so does a binding to
 * something the account must make first, like a bucket.
 */
export function blockers(m: ReleaseManifest, now: { version: VersionDetail; migration_tag: string | null }, script: string): string | null {
  const w = m.worker;
  if (!w)
    return `${m.version} was built before updates from the app, so it can't be installed from here. Deploy it from your copy of the repository.`;
  if (m.schema < MIGRATIONS.length)
    return `${m.version} is older than the Atlas running (its storage has ${m.schema} changes, this one has ${MIGRATIONS.length}). Roll back is the way back to an older Atlas.`;
  const had = now.version.resources?.bindings ?? [];
  const changes: string[] = [];
  const lastTag = w.migrations[w.migrations.length - 1] ?? null;
  if (lastTag && now.migration_tag && lastTag !== now.migration_tag)
    changes.push(`its Durable Object migration ${lastTag}, after ${now.migration_tag}`);
  const classes = new Set(had.filter((b) => b.type === "durable_object_namespace").map((b) => String(b.class_name)));
  for (const c of m.classes) if (!classes.has(c)) changes.push(`a new Durable Object class, ${c}`);
  for (const b of w.bindings)
    if (!had.some((x) => x.name === b.name) && !ADDABLE.has(b.type)) changes.push(`a new ${b.type.replace(/_/g, " ")} binding, ${b.name}`);
  if (!changes.length) return null;
  return [
    `${m.version} changes what Atlas's Worker is made of (${changes.join("; ")}), which can't ride in an update from here: Cloudflare applies that only with a full deploy, and nothing rolls back past it.`,
    `Deploy it once from a copy of the repository at ${m.version}: run npm ci, then npx wrangler login, then npm run deploy -- --name ${script}.`,
    "After that, updates from here work again.",
  ].join(" ");
}

// --- the bundle ----------------------------------------------------------------------------------------------

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a tar archive's regular files by path (ustar, GNU long names and pax paths), without a leading "./". */
export function untar(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  const cstr = (b: Uint8Array) => dec.decode(b).replace(/\0[\s\S]*$/, "");
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = cstr(h.subarray(0, 100));
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]!);
    const ustar = cstr(h.subarray(257, 262)) === "ustar";
    const prefix = ustar ? cstr(h.subarray(345, 500)) : "";
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > bytes.length) throw new Error("The bundle's archive is cut short.");
    const body = bytes.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = cstr(body);
    else if (type === "x") {
      for (const line of dec.decode(body).split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m) paxPath = m[1]!;
      }
    } else {
      if (type === "0" || type === "7") {
        const path = (paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^(\.\/)+/, "");
        if (path) out.set(path, body.slice());
      }
      longName = null;
      paxPath = null;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * Opens a release's bundle and checks every file against release.json's
 * SHA-256s before anything is uploaded: a missing, extra or changed file
 * refuses the whole bundle.
 */
export async function openBundle(gz: Uint8Array, m: ReleaseManifest, manifestBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let files: Map<string, Uint8Array>;
  try {
    files = untar(await gunzip(gz));
  } catch (err) {
    const why = err instanceof Error && err.message ? err.message : "it isn't a whole gzip archive";
    throw new Error(`The bundle couldn't be opened (${why}), so nothing was uploaded.`);
  }
  for (const [path, want] of Object.entries(m.files)) {
    const b = files.get(path);
    if (!b) throw new Error(`The bundle has no ${path}, which release.json lists, so nothing was uploaded.`);
    const got = await sha256Hex(b);
    if (got !== want)
      throw new Error(
        `${path} in the bundle doesn't match release.json's SHA-256 (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…), so nothing was uploaded.`,
      );
  }
  for (const path of files.keys())
    if (path !== MANIFEST_ASSET && !(path in m.files))
      throw new Error(`The bundle has ${path}, which release.json doesn't list, so nothing was uploaded.`);
  const inside = files.get(MANIFEST_ASSET);
  if (inside && (await sha256Hex(inside)) !== (await sha256Hex(manifestBytes)))
    throw new Error("The bundle's release.json isn't the one attached to the release, so nothing was uploaded.");
  return files;
}

// --- uploading ------------------------------------------------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const ext = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

const TYPES: Record<string, string> = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain",
  map: "application/json",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/** The asset manifest Cloudflare takes: each path, its size and a 32-character hash of its base64 and extension. */
export async function assetManifest(files: Map<string, Uint8Array>): Promise<Record<string, { hash: string; size: number; path: string }>> {
  const out: Record<string, { hash: string; size: number; path: string }> = {};
  for (const [path, b] of files) {
    if (!path.startsWith("assets/")) continue;
    const name = `/${path.slice("assets/".length)}`;
    const hash = (await sha256Hex(new TextEncoder().encode(base64(b) + ext(path)))).slice(0, 32);
    out[name] = { hash, size: b.length, path };
  }
  return out;
}

const claims = (jwt: string): Record<string, unknown> => {
  try {
    const part = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The app's files through an assets upload session; returns the completion token and how many files were new. */
export async function uploadAssets(
  f: typeof fetch,
  token: string,
  t: Target,
  files: Map<string, Uint8Array>,
): Promise<{ jwt: string; total: number; uploaded: number }> {
  const listed = await assetManifest(files);
  const manifest = Object.fromEntries(Object.entries(listed).map(([k, v]) => [k, { hash: v.hash, size: v.size }]));
  const session = await cf<{ jwt: string; buckets?: string[][] }>(f, token, `${scriptPath(t)}/assets-upload-session`, {
    method: "POST",
    body: JSON.stringify({ manifest }),
  });
  const buckets = session?.buckets ?? [];
  const total = Object.keys(manifest).length;
  if (!buckets.flat().length) return { jwt: session.jwt, total, uploaded: 0 };
  const byHash = new Map(Object.values(listed).map((v) => [v.hash, v]));
  const single = claims(session.jwt).wrangler_single_asset_uploads === true;
  let done = "";
  let uploaded = 0;
  for (const bucket of single ? buckets.flat().map((h) => [h]) : buckets) {
    const entries = bucket.map((h) => {
      const v = byHash.get(h);
      if (!v) throw new CloudflareError(`Cloudflare asked for a file Atlas didn't list (${h.slice(0, 12)}…).`, 0);
      return v;
    });
    let res: { jwt?: string } | null;
    if (single) {
      const v = entries[0]!;
      res = await cf<{ jwt?: string }>(f, session.jwt, `/accounts/${t.account_id}/workers/assets/upload/${v.hash}`, {
        method: "POST",
        headers: { "content-type": TYPES[ext(v.path)] ?? "application/null" },
        body: files.get(v.path)!,
      });
    } else {
      const form = new FormData();
      for (const v of entries)
        form.append(v.hash, new File([base64(files.get(v.path)!)], v.hash, { type: TYPES[ext(v.path)] ?? "application/null" }));
      res = await cf<{ jwt?: string }>(f, session.jwt, `/accounts/${t.account_id}/workers/assets/upload?base64=true`, {
        method: "POST",
        body: form,
      });
    }
    uploaded += entries.length;
    if (res?.jwt) done = res.jwt;
  }
  if (!done) throw new CloudflareError("Cloudflare took the app's files but gave no completion token, so the upload can't be used.", 0);
  return { jwt: done, total, uploaded };
}

const MODULE_TYPES: Record<string, string> = {
  js: "application/javascript+module",
  mjs: "application/javascript+module",
  wasm: "application/wasm",
  txt: "text/plain",
  html: "text/plain",
  bin: "application/octet-stream",
};

/**
 * The bindings for the new version: everything the running version has is
 * inherited by name (so the buckets, the Durable Objects and anything the
 * owner added stay as they are), secrets are kept, the assets binding is
 * restated, and a binding the release adds that needs nothing made first is
 * added as release.json describes it.
 */
export function versionBindings(m: ReleaseManifest, had: ApiBinding[]): ApiBinding[] {
  const out: ApiBinding[] = [];
  for (const b of had) {
    if (b.type === "secret_text" || b.type === "secret_key") continue;
    out.push(b.type === "assets" ? { type: "assets", name: b.name } : { type: "inherit", name: b.name });
  }
  for (const b of m.worker?.bindings ?? []) if (!had.some((x) => x.name === b.name) && ADDABLE.has(b.type)) out.push(b);
  return out;
}

/** Uploads the release's Worker as a new version, not yet deployed. */
export async function uploadVersion(
  f: typeof fetch,
  token: string,
  t: Target,
  o: { manifest: ReleaseManifest; files: Map<string, Uint8Array>; assets_jwt: string; had: VersionDetail },
): Promise<{ id: string; number?: number }> {
  const w = o.manifest.worker!;
  const modules = [...o.files.entries()].filter(
    ([p]) => p.startsWith("worker/") && p.indexOf("/", "worker/".length) < 0 && MODULE_TYPES[ext(p)] && !p.endsWith(".map"),
  );
  const main = `worker/${w.main_module}`;
  if (!o.files.has(main)) throw new Error(`The bundle has no ${main}, the Worker's main module, so nothing was uploaded.`);
  const containers = o.had.resources?.script_runtime?.containers ?? w.containers;
  const metadata = {
    main_module: w.main_module,
    compatibility_date: o.manifest.compatibility_date,
    compatibility_flags: w.compatibility_flags,
    bindings: versionBindings(o.manifest, o.had.resources?.bindings ?? []),
    keep_bindings: ["secret_text", "secret_key"],
    ...(Array.isArray(containers) && containers.length ? { containers } : {}),
    annotations: {
      "workers/tag": o.manifest.version.slice(0, 100),
      "workers/message": `Atlas ${o.manifest.version} (${o.manifest.commit.slice(0, 7)}), installed from Atlas settings → Account → Updates`,
    },
    assets: { jwt: o.assets_jwt, config: w.assets.config },
  };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const [p, b] of modules) {
    const name = p.slice("worker/".length);
    form.set(name, new File([b], name, { type: MODULE_TYPES[ext(p)]! }));
  }
  return cf<{ id: string; number?: number }>(f, token, `${scriptPath(t)}/versions?bindings_inherit=strict`, { method: "POST", body: form });
}

/** Sends all traffic to one version: an update's last step, and a rollback. */
export async function deploy(f: typeof fetch, token: string, t: Target, versionId: string, message: string, force = false) {
  return cf<{ id: string }>(f, token, `${scriptPath(t)}/deployments${force ? "?force=true" : ""}`, {
    method: "POST",
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { "workers/message": message.slice(0, 1000) },
    }),
  });
}

/** Who made a version, in words for the card, from Cloudflare's `metadata.source`. */
export function sourceWords(source: string | null | undefined): string {
  switch (source) {
    case "workersci":
      return "Workers Builds, after a push to your copy of the repository";
    case "wrangler":
      return "Wrangler";
    case "dash":
    case "quick_editor":
      return "the Cloudflare dashboard";
    case "api":
      return "Cloudflare's API";
    default:
      return source ? `Cloudflare (${source})` : "something other than Atlas";
  }
}
