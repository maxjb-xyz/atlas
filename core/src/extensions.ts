// Extensions (VISION §17). The core is the foundation every Atlas has; an
// extension ties it to one service: a calendar, a mail account, a chat
// channel, a maps or search provider, GitHub. Each is a module with a
// manifest (extensions/sdk.ts), and every call to it runs in a Dynamic
// Worker whose only way out is the gate below: it may reach the hosts its
// manifest names and nothing else, and its secrets go into its requests at
// the gate, so it never holds their values. It never sees the log or the
// records. What it notices comes back as items for the intake, what it
// receives as messages for the owner's thread or a face, and what it sends
// leaves through the outbox.
//
// The core keeps, for each installed extension: whether it's on, its
// settings and secrets, its cursor (where its last look left off) and its
// state, the key in its address for posts, and how its last call went. A
// source that can't post to Atlas gets a look on the one clock (§4.3): one
// agenda item for all of them, there only while one needs it.

import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Ctx, Json, Manifest, Provides, Request as ExtRequest } from "../../extensions/sdk";
import { BUNDLED } from "./extensions.gen";
import { parse, type Sql } from "./store/db";
import { append } from "./store/log";
import { type AgendaItem, createItem, finish, rearm, upcoming } from "./store/agenda";
import { getSecret, setSecret } from "./store/settings";
import { getState, setState } from "./store/state";
import { seams } from "./agent/seams";

export type { Manifest, Provides } from "../../extensions/sdk";

export type ExtSource = "bundled" | "atlas" | "owner";
export type ExtState = "on" | "off" | "draft";

export interface Installed {
  id: string;
  name: string;
  version: string;
  source: ExtSource;
  code: string | null;
  manifest: Manifest;
  /** The calls it takes, as its module declared them. */
  methods: string[];
  state: ExtState;
  settings: Record<string, string>;
  cursor: Json;
  data: Json;
  key: string;
  installed_at: number;
  updated_at: number;
  last_look: number | null;
  ok_at: number | null;
  error: string | null;
  error_at: number | null;
}

type Raw = Omit<Installed, "manifest" | "methods" | "settings" | "cursor" | "data" | "source" | "state"> & {
  manifest: string;
  methods: string;
  settings: string;
  cursor: string | null;
  data: string | null;
  source: string;
  state: string;
};

const fromRaw = (r: Raw): Installed => ({
  ...r,
  source: r.source as ExtSource,
  state: r.state as ExtState,
  // A bundled extension follows the release it shipped in: its manifest (hosts, secrets, sign-in) is the bundle's, not what was saved at install.
  manifest:
    r.source === "bundled" && BUNDLED[r.id]
      ? (BUNDLED[r.id]!.manifest as Manifest)
      : parse<Manifest>(r.manifest, { id: r.id, name: r.name, version: r.version, about: "", provides: [], hosts: [] }),
  methods: parse(r.methods, []),
  settings: parse(r.settings, {}),
  cursor: parse<Json>(r.cursor, null),
  data: parse<Json>(r.data, null),
});

export const installed = (sql: Sql): Installed[] => sql.exec<Raw>(`SELECT * FROM extensions ORDER BY name`).toArray().map(fromRaw);

export function getExt(sql: Sql, id: string): Installed | null {
  const r = sql.exec<Raw>(`SELECT * FROM extensions WHERE id = ?`, id).toArray()[0];
  return r ? fromRaw(r) : null;
}

/** The installed extensions that are on and provide `what`, in the order they were installed. */
export const providing = (sql: Sql, what: Provides): Installed[] =>
  installed(sql)
    .filter((e) => e.state === "on" && e.manifest.provides.includes(what))
    .sort((a, b) => a.installed_at - b.installed_at);

/** The code that runs for an extension: a bundled one's as this release ships it, else its own. */
export const codeOf = (e: Installed): string | null => (e.source === "bundled" ? (BUNDLED[e.id]?.code ?? null) : e.code);
/** The calls it takes. */
export const methodsOf = (e: Installed): string[] => (e.source === "bundled" ? (BUNDLED[e.id]?.methods ?? []) : e.methods);

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Installs an extension: a bundled one by its id, or one Atlas or the owner
 * wrote, with its code and the manifest and calls its code declared. An
 * extension already installed keeps its settings, secrets and cursor.
 */
export function install(
  sql: Sql,
  o: {
    id: string;
    source: ExtSource;
    code?: string;
    manifest?: Manifest;
    methods?: string[];
    state?: ExtState;
    settings?: Record<string, string>;
  },
): Installed {
  const bundled = o.source === "bundled" ? BUNDLED[o.id] : null;
  if (o.source === "bundled" && !bundled) throw new Error(`There's no extension called ${o.id} in this release.`);
  const manifest = bundled?.manifest ?? o.manifest;
  if (!manifest) throw new Error("An extension needs its manifest.");
  const now = Date.now();
  const was = getExt(sql, o.id);
  const settings = { ...defaultsOf(manifest), ...(was?.settings ?? {}), ...(o.settings ?? {}) };
  sql.exec(
    `INSERT INTO extensions (id, name, version, source, code, manifest, methods, state, settings, cursor, data, key, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, source = excluded.source, code = excluded.code,
       manifest = excluded.manifest, methods = excluded.methods, state = excluded.state, settings = excluded.settings, updated_at = excluded.updated_at`,
    o.id,
    manifest.name,
    manifest.version,
    o.source,
    bundled ? null : (o.code ?? null),
    JSON.stringify(manifest),
    JSON.stringify(bundled?.methods ?? o.methods ?? []),
    o.state ?? (was?.state === "off" ? "off" : "on"),
    JSON.stringify(settings),
    was?.key ?? randomKey(),
    was?.installed_at ?? now,
    now,
  );
  if (!was) append(sql, { actor: "owner", kind: "settings.change", body: { extension: "installed", name: manifest.name, id: o.id } });
  return getExt(sql, o.id)!;
}

const defaultsOf = (m: Manifest): Record<string, string> =>
  Object.fromEntries((m.settings ?? []).filter((s) => s.default != null).map((s) => [s.name, s.default!]));

/** Removes an extension and forgets its secrets, cursor and state. */
export function uninstall(sql: Sql, id: string): Installed | null {
  const e = getExt(sql, id);
  if (!e) return null;
  sql.exec(`DELETE FROM extensions WHERE id = ?`, id);
  setSecret(sql, `ext:${id}`, null);
  append(sql, { actor: "owner", kind: "settings.change", body: { extension: "removed", name: e.name, id } });
  return e;
}

export function setExtState(sql: Sql, id: string, state: "on" | "off"): Installed | null {
  const e = getExt(sql, id);
  if (!e || e.state === state) return e;
  sql.exec(`UPDATE extensions SET state = ?, updated_at = ? WHERE id = ?`, state, Date.now(), id);
  append(sql, {
    actor: "owner",
    kind: "settings.change",
    body: { extension: state === "on" ? "turned on" : "turned off", name: e.name, id },
  });
  return getExt(sql, id);
}

export function setExtSettings(sql: Sql, id: string, patch: Record<string, string>): void {
  const e = getExt(sql, id);
  if (!e) return;
  const allowed = new Set([...(e.manifest.settings ?? []).map((s) => s.name), ...(e.manifest.signin ? ["client_id"] : [])]);
  const settings = { ...e.settings };
  for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) settings[k] = v.trim();
  sql.exec(`UPDATE extensions SET settings = ?, updated_at = ? WHERE id = ?`, JSON.stringify(settings), Date.now(), id);
}

export const extSecrets = (sql: Sql, id: string): Record<string, string> => getSecret<Record<string, string>>(sql, `ext:${id}`) ?? {};

/** Sets secrets the owner pasted (an empty value removes one). Only names the manifest declares, or a sign-in's tokens. */
export function setExtSecrets(sql: Sql, id: string, patch: Record<string, string | null>): void {
  const e = getExt(sql, id);
  if (!e) return;
  const allowed = new Set([
    ...(e.manifest.secrets ?? []).map((s) => s.name),
    ...(e.manifest.signin ? ["client_secret", ...TOKEN_KEYS] : []),
  ]);
  const all = extSecrets(sql, id);
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (v == null || v === "") delete all[k];
    else all[k] = tidied(v, (e.manifest.secrets ?? []).find((x) => x.name === k)?.tidy);
  }
  setSecret(sql, `ext:${id}`, Object.keys(all).length ? all : null);
  sql.exec(`UPDATE extensions SET updated_at = ? WHERE id = ?`, Date.now(), id);
  append(sql, { actor: "owner", kind: "settings.change", body: { extension: "secrets set", name: e.name, id, keys: Object.keys(patch) } });
}

const TOKEN_KEYS = ["access_token", "refresh_token", "expires_at"];

/** A pasted secret in the form its service writes it, as the manifest says (SecretSpec.tidy). */
export function tidied(v: string, t?: { when: string; group: number; join: string; lower?: boolean }): string {
  const bare = v.trim();
  if (!t) return bare;
  const letters = bare.replace(/[\s-]+/g, "");
  let re: RegExp;
  try {
    re = new RegExp(t.when);
  } catch {
    return bare;
  }
  if (!re.test(letters) || t.group < 1) return bare;
  const cased = t.lower ? letters.toLowerCase() : letters;
  return (cased.match(new RegExp(`.{1,${Math.floor(t.group)}}`, "g")) ?? []).join(t.join);
}

export function saveCursor(sql: Sql, id: string, cursor: Json, at = Date.now()): void {
  sql.exec(`UPDATE extensions SET cursor = ?, last_look = ? WHERE id = ?`, JSON.stringify(cursor ?? null), at, id);
}

export function saveData(sql: Sql, id: string, data: Json): void {
  sql.exec(`UPDATE extensions SET data = ? WHERE id = ?`, data == null ? null : JSON.stringify(data), id);
}

/** How the last call went, for the Senses screen and Settings: worked, or the service's own words. */
export function noteExt(sql: Sql, id: string, error?: string): void {
  if (error) sql.exec(`UPDATE extensions SET error = ?, error_at = ? WHERE id = ?`, error.slice(0, 500), Date.now(), id);
  else sql.exec(`UPDATE extensions SET ok_at = ?, error = NULL, error_at = NULL WHERE id = ?`, Date.now(), id);
}

// --- the gate: the sandbox's only way out ----------------------------------------------------------------

export interface GateProps {
  /** The person agent it belongs to, so a refusal can be noted there. */
  agent: string;
  ext: string;
  name: string;
  hosts: string[];
  secrets: Record<string, string>;
}

export const allowedHost = (host: string, hosts: string[]) =>
  hosts.some((h) => {
    const want = h.toLowerCase().replace(/^\*\./, "");
    return host === want || host.endsWith(`.${want}`);
  });

const PLACEHOLDER = /(?:\{|%7B){2}secret(?::|%3A)([a-z0-9_]+)(?:\}|%7D){2}/gi;
const BASIC = /Basic \{\{basic:([A-Za-z0-9+/=]*):([a-z0-9_]+)\}\}/g;

const b64 = (s: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** Puts secrets into a request's text where its placeholders are. In an address, values are encoded (keeping ":", which some tokens hold). */
export function fill(text: string, secrets: Record<string, string>, inUrl = false): string {
  return text
    .replace(BASIC, (m, user: string, name: string) => (secrets[name] == null ? m : `Basic ${b64(`${unb64(user)}:${secrets[name]}`)}`))
    .replace(PLACEHOLDER, (m, name: string) => {
      const v = secrets[name];
      if (v == null) return m;
      return inUrl ? encodeURIComponent(v).replace(/%3A/gi, ":") : v;
    });
}

export const textual = (type: string | null) => !type || /json|text|xml|x-www-form-urlencoded|javascript|graphql/i.test(type);

/**
 * Every request an extension makes comes here. A host its manifest names
 * gets the request, with its secrets put in; anything else is refused with
 * a reason the extension passes on, and noted. Redirects are followed here,
 * one hop at a time, so one can't lead outside the hosts. Secrets that come
 * back in a text answer are hidden before the extension sees it.
 */
export class ExtensionGate extends WorkerEntrypoint<Env, GateProps> {
  override async fetch(req: Request): Promise<Response> {
    const p = this.ctx.props;
    let url = fill(req.url, p.secrets, true);
    const headers = new Headers();
    for (const [k, v] of req.headers) headers.set(k, fill(v, p.secrets));
    const body =
      req.body && textual(req.headers.get("content-type")) ? fill(await req.text(), p.secrets) : req.body ? await req.arrayBuffer() : null;
    for (let hop = 0; hop < 6; hop++) {
      const host = new URL(url).hostname.toLowerCase();
      if (!allowedHost(host, p.hosts)) {
        await getAgentByName(this.env.PersonAgent, p.agent)
          .then((a) => (a as unknown as { apiGateRefused(ext: string, host: string): Promise<void> }).apiGateRefused(p.ext, host))
          .catch(() => {});
        return new Response(`Atlas's gate refused ${host}: the ${p.name} extension may reach only ${p.hosts.join(", ")}.`, {
          status: 403,
          headers: { "content-type": "text/plain", "x-atlas-gate": "refused" },
        });
      }
      const res = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
      const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (to) {
        url = new URL(to, url).toString();
        continue;
      }
      const values = Object.values(p.secrets).filter((v) => v.length >= 8);
      if (!values.length || !textual(res.headers.get("content-type"))) return res;
      let text = await res.text();
      for (const v of values) text = text.split(v).join("[hidden]");
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return new Response("Atlas's gate: too many redirects.", { status: 508, headers: { "content-type": "text/plain" } });
  }
}

// --- running a call ----------------------------------------------------------------------------------------

/** What runs in the sandbox around an extension's module: one call in, its answer or its failure out. */
const RUNNER = `import ext from "./ext.js";
const secret = (name) => "{{secret:" + name + "}}";
const basic = (user, name) => "Basic {{basic:" + btoa(String.fromCharCode(...new TextEncoder().encode(user))) + ":" + name + "}}";
export default {
  async fetch(request) {
    const { method, ctx, args } = await request.json();
    if (method === "describe") {
      const methods = Object.keys(ext ?? {}).filter((k) => typeof ext[k] === "function");
      return Response.json({ ok: true, value: { manifest: ext?.manifest ?? null, methods } });
    }
    const fn = ext && ext[method];
    if (typeof fn !== "function") return Response.json({ ok: false, error: (ext?.manifest?.name ?? "This extension") + " has no " + method + " call.", code: "protocol" });
    try {
      const value = await fn.call(ext, { ...ctx, secret, basic }, ...(args ?? []));
      return Response.json({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.message) || e), code: (e && e.code) || null, status: (e && e.status) || null });
    }
  },
};
`;

export class ExtensionError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface HostDeps {
  sql: Sql;
  /** The Worker Loader binding, or null where extensions can't run. */
  loader(): WorkerLoader | null;
  /** The gate, for one extension's calls. */
  gate(props: GateProps): Fetcher;
  /** The agent's name, for the gate's notes. */
  agent: string;
  /** For sign-ins, which the core runs itself. */
  fetch: typeof fetch;
  /** This deployment's address, for extensions' own addresses and sign-in redirects. */
  origin(): string | null;
  tz(): string;
}

const hash = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export class ExtensionHost {
  #paced = new Map<string, Promise<unknown>>();

  constructor(private readonly d: HostDeps) {}

  /** The address an extension takes posts at, when it does. */
  address(e: Installed): string | undefined {
    const origin = this.d.origin();
    return e.manifest.receives && origin ? `${origin}/x/${e.id}/${e.key}` : undefined;
  }

  /**
   * One call to an extension, in its sandbox. Throws an ExtensionError in
   * the extension's (and the service's) own words. `data` is what the core
   * shares for the call; state the call gives back is kept.
   */
  async call<T>(id: string, method: string, args: unknown[] = [], o: { data?: Json; ms?: number; any?: boolean } = {}): Promise<T> {
    const e = getExt(this.d.sql, id);
    if (!e) throw new ExtensionError(`The ${id} extension isn't installed.`, "missing");
    if (e.state !== "on" && !o.any) throw new ExtensionError(`The ${e.name} extension is off.`, "off");
    const code = codeOf(e);
    if (!code) throw new ExtensionError(`The ${e.name} extension's code isn't in this release.`, "missing");
    const run = async () => {
      const value = await this.#run<T & { state?: Json }>(e, code, method, args, o);
      if (value && typeof value === "object" && "state" in value && value.state !== undefined) saveData(this.d.sql, id, value.state);
      return value as T;
    };
    // Free services ask to be called gently: calls to one extension wait their turn and its gap.
    const gap = e.manifest.pace_ms ?? 0;
    if (!gap) return run();
    const before = this.#paced.get(id) ?? Promise.resolve();
    const next = before
      .catch(() => {})
      .then(async () => {
        try {
          return await run();
        } finally {
          await new Promise((r) => setTimeout(r, gap));
        }
      });
    this.#paced.set(id, next);
    return next;
  }

  async #run<T>(e: Installed, code: string, method: string, args: unknown[], o: { data?: Json; ms?: number }): Promise<T> {
    const secrets = await this.#secrets(e);
    const ctx: Omit<Ctx, "secret" | "basic"> = {
      cursor: e.cursor,
      state: e.data,
      settings: e.settings,
      now: Date.now(),
      tz: this.d.tz(),
      ...(this.address(e) ? { address: this.address(e)! } : {}),
      ...(o.data !== undefined ? { data: o.data } : {}),
    };
    if (seams.extension) {
      try {
        return (await seams.extension({
          id: e.id,
          method,
          args,
          ctx: ctx as Record<string, unknown>,
          secrets,
          hosts: e.manifest.hosts,
        })) as T;
      } catch (err) {
        const x = err as { message?: string; code?: string; status?: number };
        throw new ExtensionError(x.message ?? String(err), x.code ?? null, x.status ?? null);
      }
    }
    const loader = this.d.loader();
    if (!loader) throw new ExtensionError("This deployment can't run extensions (it has no Worker Loader binding).", "missing");
    const stamp = await hash(`${code}\n${JSON.stringify(secrets)}\n${e.manifest.hosts.join(",")}`);
    const worker = loader.get(`ext:${e.id}:${stamp}`, () => ({
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "run.js",
      modules: { "run.js": RUNNER, "ext.js": code },
      globalOutbound: this.d.gate({ agent: this.d.agent, ext: e.id, name: e.name, hosts: e.manifest.hosts, secrets }),
      limits: { cpuMs: 10_000, subRequests: 200 },
    }));
    let res: Response;
    try {
      res = await worker.getEntrypoint().fetch("https://extension/", {
        method: "POST",
        body: JSON.stringify({ method, ctx, args }),
        signal: AbortSignal.timeout(o.ms ?? 30_000),
      });
    } catch (err) {
      throw new ExtensionError(`The ${e.name} extension didn't answer: ${err instanceof Error ? err.message : String(err)}`, "network");
    }
    const out = (await res.json().catch(() => null)) as { ok: boolean; value?: T; error?: string; code?: string; status?: number } | null;
    if (!out) throw new ExtensionError(`The ${e.name} extension answered something Atlas can't read (HTTP ${res.status}).`, "protocol");
    if (!out.ok) throw new ExtensionError(out.error ?? `The ${e.name} extension failed.`, out.code ?? null, out.status ?? null);
    return out.value as T;
  }

  /** Its secrets for a call, with a sign-in's access token refreshed first when it's about to run out. */
  async #secrets(e: Installed): Promise<Record<string, string>> {
    const all = extSecrets(this.d.sql, e.id);
    const s = e.manifest.signin;
    if (!s || !all.refresh_token) return all;
    const expires = Number(all.expires_at ?? 0);
    if (all.access_token && expires > Date.now() + 60_000) return all;
    const fresh = await this.#token(e, { grant_type: "refresh_token", refresh_token: all.refresh_token });
    return { ...extSecrets(this.d.sql, e.id), ...fresh };
  }

  /** Exchanges a code or a refresh token at the extension's token endpoint, and keeps what comes back. */
  async #token(e: Installed, grant: Record<string, string>): Promise<Record<string, string>> {
    const s = e.manifest.signin!;
    const host = new URL(s.token).hostname;
    if (!allowedHost(host, e.manifest.hosts))
      throw new ExtensionError(`${e.name}'s sign-in goes to ${host}, which its manifest doesn't name.`, "refused");
    const secret = extSecrets(this.d.sql, e.id).client_secret ?? "";
    const body = new URLSearchParams({ ...grant, client_id: e.settings.client_id ?? "", client_secret: secret });
    let res: Response;
    try {
      res = await this.d.fetch(s.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
    } catch (err) {
      throw new ExtensionError(
        `Couldn't reach ${host} to sign in to ${e.name}: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    const text = await res.text();
    const j = parse<Record<string, unknown>>(text, {});
    if (!res.ok || typeof j.access_token !== "string") {
      const why =
        typeof j.error_description === "string" ? j.error_description : typeof j.error === "string" ? j.error : text.slice(0, 200);
      throw new ExtensionError(`${host} refused ${e.name}'s sign-in (HTTP ${res.status}): ${why}`, "auth", res.status);
    }
    const kept: Record<string, string> = {
      access_token: j.access_token,
      expires_at: String(Date.now() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000),
      ...(typeof j.refresh_token === "string" ? { refresh_token: j.refresh_token } : {}),
    };
    const all = { ...extSecrets(this.d.sql, e.id), ...kept };
    setSecret(this.d.sql, `ext:${e.id}`, all);
    return kept;
  }

  /** The page the owner signs in on, for an extension with a sign-in. */
  signinUrl(id: string): string {
    const e = getExt(this.d.sql, id);
    const s = e?.manifest.signin;
    if (!e || !s) throw new Error("That extension has no sign-in.");
    const origin = this.d.origin();
    if (!origin) throw new Error("Open Atlas in the browser once first, so it knows its own address.");
    if (!e.settings.client_id) throw new Error(`${e.name} needs your client id first: ${s.help}`);
    const state = randomKey();
    const pending = getState<Record<string, { id: string; at: number }>>(this.d.sql, "ext_signins") ?? {};
    for (const [k, v] of Object.entries(pending)) if (Date.now() - v.at > 30 * 60_000) delete pending[k];
    pending[state] = { id, at: Date.now() };
    setState(this.d.sql, "ext_signins", pending);
    const u = new URL(s.authorize);
    u.searchParams.set("client_id", e.settings.client_id);
    u.searchParams.set("redirect_uri", `${origin}/x/signin`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", s.scopes.join(" "));
    u.searchParams.set("state", state);
    for (const [k, v] of Object.entries(s.params ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  /** The sign-in page sent the owner back with a code: exchange it. Returns the extension it was for. */
  async signedIn(state: string, code: string): Promise<Installed> {
    const pending = getState<Record<string, { id: string; at: number }>>(this.d.sql, "ext_signins") ?? {};
    const p = pending[state];
    if (!p || Date.now() - p.at > 30 * 60_000)
      throw new Error("That sign-in wasn't started here, or it took longer than half an hour. Start it again in Settings.");
    delete pending[state];
    setState(this.d.sql, "ext_signins", pending);
    const e = getExt(this.d.sql, p.id);
    if (!e) throw new Error("That extension was removed since.");
    await this.#token(e, { grant_type: "authorization_code", code, redirect_uri: `${this.d.origin()}/x/signin` });
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { extension: "signed in", name: e.name, id: e.id } });
    return e;
  }

  /** Reads what a module declares, sandboxed with no way out: for drafts Atlas or the owner wrote. */
  async describe(code: string): Promise<{ manifest: Manifest; methods: string[] }> {
    const loader = this.d.loader();
    if (!loader) throw new ExtensionError("This deployment can't run extensions.", "missing");
    const worker = loader.get(`draft:${await hash(code)}`, () => ({
      compatibilityDate: "2026-10-01",
      mainModule: "run.js",
      modules: { "run.js": RUNNER, "ext.js": code },
      globalOutbound: null,
      limits: { cpuMs: 2_000 },
    }));
    const res = await worker
      .getEntrypoint()
      .fetch("https://extension/", { method: "POST", body: JSON.stringify({ method: "describe", ctx: {}, args: [] }) });
    const out = (await res.json().catch(() => null)) as {
      ok: boolean;
      value?: { manifest: Manifest | null; methods: string[] };
      error?: string;
    } | null;
    if (!out?.ok || !out.value?.manifest)
      throw new ExtensionError(out?.error ?? "The code didn't load, or it has no default export with a manifest.", "protocol");
    return { manifest: out.value.manifest, methods: out.value.methods };
  }
}

// --- checking a post ------------------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const same = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};

/** Whether a post may reach an extension: its key in the address, and the service's signature when the manifest asks for one. */
export async function postAllowed(sql: Sql, e: Installed, key: string, req: ExtRequest): Promise<string | null> {
  if (!same(key, e.key)) return "the address's key doesn't match";
  if (e.state !== "on") return `the ${e.name} extension is off`;
  const th = e.manifest.receives?.token_header;
  if (th && !same(req.headers[th.toLowerCase()] ?? "", e.key)) return `the post doesn't carry ${e.name}'s secret token`;
  const sig = e.manifest.receives?.signature;
  if (!sig) return null;
  const secret = extSecrets(sql, e.id)[sig.secret];
  if (!secret) return `${e.name} has no ${sig.secret} to check the signature with`;
  const given = (req.headers[sig.header.toLowerCase()] ?? "").replace(sig.prefix ?? "", "").toLowerCase();
  if (!given) return `the post has no ${sig.header} signature`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return same(given, hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(req.body)))) ? null : "the signature doesn't match";
}

// --- the looks on the clock ------------------------------------------------------------------------------

/** When each extension that looks is next due, and the soonest. */
export function nextLooks(sql: Sql, now = Date.now()): { due: Installed[]; next: number | null } {
  const lookers = installed(sql).filter((e) => {
    if (e.state !== "on" || !e.manifest.every || !methodsOf(e).includes("look")) return false;
    const have = extSecrets(sql, e.id);
    return (e.manifest.look_needs ?? []).every((n) => have[n]);
  });
  const at = (e: Installed) => (e.last_look ?? 0) + e.manifest.every! * 60_000;
  return {
    due: lookers.filter((e) => at(e) <= now + 5_000),
    next: lookers.length ? Math.max(now + 5_000, Math.min(...lookers.map(at))) : null,
  };
}

/**
 * The extensions' look's place on the clock: one item, at the soonest
 * extension's time, while any installed extension looks; none otherwise,
 * so with nothing to ask nothing runs (§19.3).
 */
export function armLooks(sql: Sql, now = Date.now()): { item: AgendaItem | null; cancel: AgendaItem | null } {
  const open = upcoming(sql, 300).find((i) => i.kind === "looks");
  const { next } = nextLooks(sql, now);
  if (next == null) {
    if (open) finish(sql, open.id, "cancelled", null, { why: "No extension looks on the clock now." });
    return { item: null, cancel: open ?? null };
  }
  if (open && open.state === "scheduled" && Math.abs(open.due_at - next) < 1_000) return { item: null, cancel: null };
  const item = open
    ? rearm(sql, open.id, next)
    : createItem(sql, { kind: "looks", title: "Ask the extensions what's new", due_at: next, source: { via: "extensions" } });
  return { item, cancel: null };
}
