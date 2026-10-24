// The services desk (VISION §17: services, one catalog). It turns the
// catalog (core/src/services.ts), what's installed and the connected MCP
// servers into one card per service; installs a service's parts (a bundled
// extension, pinned code checked against its hash, the vendor's MCP server,
// skill folders), with one key or sign-in where one covers them all; looks
// at the indexes once a day on the clock; and keeps code from an index up to
// date, asking first when an update would reach or hold more than before.
// Custom: an extension from a link becomes a draft, read before Install.

import type { Manifest } from "../../../extensions/sdk";
import { BUNDLED } from "../extensions.gen";
import {
  type ExtensionHost,
  extSecrets,
  getExt,
  type Installed,
  install,
  installed,
  methodsOf,
  setExtSecrets,
  uninstall,
} from "../extensions";
import { forModel, readOnly, type McpClient, type McpServer } from "../mcp";
import type { IndexView, ServicePreview, ServiceView } from "../protocol";
import {
  armIndex,
  catalog,
  DEFAULT_INDEX,
  fetchBytes,
  fetchPinned,
  holdsOf,
  indexLooks,
  indexSources,
  type Listed,
  MAX_CODE_BYTES,
  MAX_FILE_BYTES,
  MAX_INDEX_BYTES,
  noteIndexLook,
  outside,
  pendingUpdates,
  type PinnedExtension,
  pins,
  reachOf,
  readIndex,
  setPending,
  setPin,
  type SkillPart,
  widening,
} from "../services";
import { FILE_PATH, findSkill, parseSkillMd, saveSkill, setSkillFiles, setSkillState, skillFileKey, type SkillFile, slug } from "../skills";
import type { AgendaItem } from "../store/agenda";
import { finish } from "../store/agenda";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { EXT_ASKS, heldAs } from "../tools/extensions";
import type { ToolContext } from "../tools/types";
import { ManifestShape } from "./extensions";

export interface ServiceDeps {
  sql: Sql;
  host: ExtensionHost;
  /** Keeps code from a link as a draft, through the extension desk's draft reader. */
  draft(code: string): Promise<Installed>;
  /** After an extension changed: its looks on the clock again, and Settings told. */
  extensionsChanged(): Promise<void>;
  fetch(): typeof fetch;
  mcp(): McpClient | null;
  /** Where skills' files live (R2), or null. */
  files(): R2Bucket | null;
  clock: ToolContext["clock"];
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return u;
  }
};
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What an extension provides, as what Atlas hears from it. */
function hearing(m: Manifest): string[] {
  const out: string[] = [];
  if ((m.provides.includes("sense") || m.provides.includes("mail")) && m.every) out.push(`What's new, asked every ${m.every} minutes`);
  if (m.receives) out.push("What it posts to Atlas, as it happens");
  if (m.provides.includes("channel")) out.push("Messages to Atlas there");
  if (m.provides.includes("mail")) out.push("Your mail");
  if (m.provides.includes("calendar")) out.push("Your calendar");
  if (m.provides.includes("contacts")) out.push("Your address book");
  if (m.provides.includes("location")) out.push("Where you are");
  return out;
}

export class ServiceDesk {
  constructor(private readonly d: ServiceDeps) {}

  // --- the cards ----------------------------------------------------------------------------------------

  /** One card per service: the catalog's, then anything added by hand. `servers` are the connected MCP servers. */
  views(servers: McpServer[]): ServiceView[] {
    const sql = this.d.sql;
    const mine = installed(sql);
    const pinned = pins(sql);
    const updates = pendingUpdates(sql);
    const heard = this.#heard();
    const claimedExt = new Set<string>();
    const claimedMcp = new Set<string>();
    const cards: ServiceView[] = [];

    for (const s of catalog(sql)) {
      const extId = s.extension ? ("bundled" in s.extension ? s.extension.bundled : s.extension.id) : null;
      const e = extId ? (mine.find((x) => x.id === extId) ?? null) : null;
      if (e) claimedExt.add(e.id);
      const server = s.mcp ? (servers.find((x) => sameUrl(x.url, s.mcp!.url)) ?? null) : null;
      if (server) claimedMcp.add(server.id);
      const m: Manifest | null = e?.manifest ?? (extId && BUNDLED[extId] ? BUNDLED[extId]!.manifest : null);
      const secrets = e ? extSecrets(sql, e.id) : {};
      const skills = s.skills.map((k) => ({ name: k.name, installed: findSkill(sql, slug(k.name))?.state === "active" }));
      const setup = this.#setup(s, e, secrets, server);
      const anything = Boolean(e || server || skills.some((k) => k.installed));
      const extError =
        e?.error && (e.error_at ?? 0) >= (e.ok_at ?? 0) ? { text: e.error, at: e.error_at, part: "extension" as const } : null;
      const mcpError = server?.state === "failed" ? { text: server.error ?? "It didn't connect.", at: null, part: "mcp" as const } : null;
      const setupDone = setup.kind === "key" ? setup.set : setup.kind === "signin" ? setup.signed_in : true;
      const state: ServiceView["state"] = !anything
        ? "available"
        : e?.state === "draft"
          ? "draft"
          : e?.state === "off"
            ? "off"
            : extError || mcpError
              ? "error"
              : !setupDone || server?.state === "authenticating"
                ? "setup"
                : "on";
      const pin = e ? pinned[e.id] : undefined;
      const listedPart = s.extension && "code" in s.extension ? s.extension : null;
      cards.push({
        id: s.id,
        name: s.name,
        about: s.about,
        icon: s.icon ?? m?.icon ?? null,
        icon_invert: Boolean(s.icon ? s.icon_invert : m?.icon_invert),
        category: s.category,
        state,
        from: { kind: "index", index: s.index, snapshot: s.snapshot },
        hears: { summary: s.hears ?? null, what: m ? hearing(m) : [], recent: e ? (heard.get(e.id) ?? []).slice(0, 3) : [] },
        does: { summary: s.does ?? null, tools: [...this.#mcpTools(server), ...this.#extTools(m)] },
        touches: {
          hosts: m ? reachOf(m) : (listedPart?.hosts ?? []),
          secrets: m ? holdsOf(m) : (listedPart?.secrets ?? []),
          mcp: s.mcp ? host(s.mcp.url) : null,
        },
        last_heard: e ? (heard.get(e.id)?.[0]?.at ?? null) : null,
        error: extError ?? mcpError,
        cost: s.cost ?? m?.costs ?? null,
        setup,
        parts: {
          extension: extId
            ? {
                id: extId,
                version: m?.version ?? null,
                source: e?.source ?? null,
                state: e?.state ?? "available",
                pinned: pin
                  ? { code: pin.code, sha256: pin.sha256 }
                  : listedPart
                    ? { code: listedPart.code, sha256: listedPart.sha256 }
                    : null,
              }
            : null,
          mcp: s.mcp ? { id: server?.id ?? null, url: s.mcp.url, state: server?.state ?? "not added", signin: s.mcp.signin } : null,
          skills,
        },
        update: e && updates[e.id] ? { version: updates[e.id]!.version, widens: updates[e.id]!.widens } : null,
      });
    }

    // Added by hand (Custom): an extension from a link or one Atlas wrote, and MCP servers no listing names.
    for (const e of mine.filter((x) => !claimedExt.has(x.id))) {
      const error = e.error && (e.error_at ?? 0) >= (e.ok_at ?? 0) ? { text: e.error, at: e.error_at, part: "extension" as const } : null;
      cards.push({
        id: `ext:${e.id}`,
        name: e.name,
        about: e.manifest.about,
        icon: e.manifest.icon ?? null,
        icon_invert: Boolean(e.manifest.icon_invert),
        category: "custom",
        state: e.state === "draft" ? "draft" : e.state === "off" ? "off" : error ? "error" : "on",
        from: { kind: "custom" },
        hears: { summary: null, what: hearing(e.manifest), recent: (heard.get(e.id) ?? []).slice(0, 3) },
        does: { summary: null, tools: this.#extTools(e.manifest) },
        touches: { hosts: reachOf(e.manifest), secrets: holdsOf(e.manifest), mcp: null },
        last_heard: heard.get(e.id)?.[0]?.at ?? null,
        error,
        cost: e.manifest.costs ?? null,
        setup: { kind: "each" },
        parts: {
          extension: {
            id: e.id,
            version: e.version,
            source: e.source,
            state: e.state,
            pinned: pinned[e.id] ? { code: pinned[e.id]!.code, sha256: pinned[e.id]!.sha256 } : null,
          },
          mcp: null,
          skills: [],
        },
        update: null,
      });
    }
    for (const s of servers.filter((x) => !claimedMcp.has(x.id))) {
      cards.push({
        id: `mcp:${s.id}`,
        name: s.name,
        about: (s.instructions ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || `An MCP server at ${host(s.url)}.`,
        icon: null,
        icon_invert: false,
        category: "custom",
        state: s.state === "failed" ? "error" : s.state === "authenticating" ? "setup" : "on",
        from: { kind: "custom" },
        hears: { summary: null, what: [], recent: [] },
        does: { summary: null, tools: this.#mcpTools(s) },
        touches: { hosts: [], secrets: [], mcp: host(s.url) },
        last_heard: null,
        error: s.state === "failed" ? { text: s.error ?? "It didn't connect.", at: null, part: "mcp" } : null,
        cost: null,
        setup: {
          kind: "signin",
          via: "mcp",
          signed_in: s.state !== "authenticating",
          url: s.state === "authenticating" ? s.auth_url : null,
        },
        parts: { extension: null, mcp: { id: s.id, url: s.url, state: s.state, signin: null }, skills: [] },
        update: null,
      });
    }
    const rank = (c: ServiceView) => (c.state === "available" ? 1 : 0);
    return cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** The indexes the catalog reads, with how their last look went. */
  indexes(): IndexView[] {
    const looks = indexLooks(this.d.sql);
    return indexSources(this.d.sql).map((url) => {
      const l = looks[url];
      return {
        url,
        own: url === DEFAULT_INDEX,
        name: l?.index?.name ?? (url === DEFAULT_INDEX ? "Atlas" : null),
        updated: l?.index?.updated ?? null,
        at: l?.at ?? null,
        ok_at: l?.ok_at ?? null,
        error: l?.error ?? null,
        problems: l?.problems ?? [],
        services: l?.index?.services.length ?? 0,
      };
    });
  }

  #setup(s: Listed, e: Installed | null, secrets: Record<string, string>, server: McpServer | null): ServiceView["setup"] {
    const st = s.setup;
    if (st.kind === "key")
      return {
        kind: "key",
        label: st.label,
        help: st.help,
        set:
          (st.secret ? Boolean(secrets[st.secret]) : true) &&
          (st.mcp && s.mcp ? Boolean(server && server.state !== "authenticating") : true),
        covers: [...(st.secret && s.extension ? ["extension" as const] : []), ...(st.mcp && s.mcp ? ["mcp" as const] : [])],
      };
    if (st.kind === "signin")
      return st.via === "mcp"
        ? {
            kind: "signin",
            via: "mcp",
            signed_in: Boolean(server && server.state !== "authenticating" && server.state !== "failed"),
            url: server?.state === "authenticating" ? server.auth_url : null,
          }
        : { kind: "signin", via: "extension", signed_in: Boolean(secrets.refresh_token || secrets.access_token), url: null };
    return st;
  }

  #mcpTools(server: McpServer | null): ServiceView["does"]["tools"] {
    if (!server || server.state !== "ready") return [];
    return server.tools.filter(forModel).map((t) => ({
      name: t.name,
      title: t.title ?? t.annotations?.title ?? t.name,
      about: (t.description ?? "").split(/(?<=\.)\s/)[0]!.slice(0, 200),
      via: "mcp" as const,
      asks: readOnly(t) ? ("never" as const) : t.annotations?.destructiveHint === true ? ("always" as const) : ("until_trusted" as const),
      kind: null,
    }));
  }

  #extTools(m: Manifest | null): ServiceView["does"]["tools"] {
    const all = m?.tools ?? [];
    return all.map((t) => {
      const kind = heldAs(t, all, m?.id);
      return {
        name: t.name,
        title: t.name.replace(/_/g, " "),
        about: t.description.split(/(?<=\.)\s/)[0]!.slice(0, 200),
        via: "extension" as const,
        asks: EXT_ASKS[kind].asks,
        kind,
      };
    });
  }

  /** What each extension's items said lately, newest first. */
  #heard(): Map<string, Array<{ what: string; at: number }>> {
    const rows = this.d.sql
      .exec<{ ext: string; what: string | null; at: number }>(
        `SELECT json_extract(body, '$.ext') AS ext, json_extract(body, '$.what') AS what, at FROM log
         WHERE kind = 'sense' AND json_extract(body, '$.ext') IS NOT NULL ORDER BY seq DESC LIMIT 300`,
      )
      .toArray();
    const out = new Map<string, Array<{ what: string; at: number }>>();
    for (const r of rows) {
      const list = out.get(r.ext) ?? [];
      if (list.length < 3) list.push({ what: String(r.what ?? "").slice(0, 200), at: r.at });
      out.set(r.ext, list);
    }
    return out;
  }

  // --- previewing and installing -------------------------------------------------------------------------

  #listed(id: string): Listed {
    const s = catalog(this.d.sql).find((x) => x.id === id);
    if (!s) throw new Error(`There's no service called ${id} in the catalog.`);
    return s;
  }

  /**
   * Fetches a pinned extension and checks it: the bytes against the
   * listing's hash, then its manifest (read in a sandbox with no way out)
   * against the draft reader's rules and against what the listing says it
   * may reach and hold.
   */
  async #pinnedCode(part: PinnedExtension): Promise<{ code: string; manifest: Manifest; methods: string[] }> {
    if (BUNDLED[part.id]) throw new Error(`"${part.id}" is the id of an extension that ships with Atlas, so no index may replace it.`);
    const code = text(await fetchPinned(this.d.fetch(), part.code, part.sha256, MAX_CODE_BYTES));
    const { manifest, methods } = await this.d.host.describe(code);
    const shape = ManifestShape.safeParse(manifest);
    if (!shape.success)
      throw new Error(
        `Its manifest isn't right: ${shape.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ")}`,
      );
    if (manifest.id !== part.id) throw new Error(`Its code calls itself "${manifest.id}", but its listing says "${part.id}".`);
    const why = outside(manifest, part);
    if (why) throw new Error(`Its code ${why}, so it wasn't installed.`);
    if ((manifest.tools ?? []).length && !methods.includes("tool")) throw new Error("It declares tools but has no tool call.");
    return { code, manifest, methods };
  }

  /** Fetches a skill folder and checks every file against its hash. */
  async #skillFolder(k: SkillPart): Promise<{ md: string; files: Array<{ path: string; bytes: Uint8Array }> }> {
    const f = this.d.fetch();
    let md = "";
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const [path, sha] of Object.entries(k.files)) {
      if (path !== "SKILL.md" && !FILE_PATH.test(path))
        throw new Error(
          `${k.name}'s file ${path} isn't where the standard keeps a skill's files (references/, scripts/, templates/, assets/, examples/).`,
        );
      const bytes = await fetchPinned(f, new URL(path, k.base).toString(), sha, MAX_FILE_BYTES);
      if (path === "SKILL.md") md = text(bytes);
      else files.push({ path, bytes });
    }
    return { md, files };
  }

  /** What installing a service would add, fetched and checked first: the extension's code and reach, the MCP server, each skill in full. */
  async preview(id: string): Promise<ServicePreview> {
    const s = this.#listed(id);
    let extension: ServicePreview["extension"] = null;
    if (s.extension) {
      const got =
        "bundled" in s.extension
          ? BUNDLED[s.extension.bundled]
            ? { code: null, manifest: BUNDLED[s.extension.bundled]!.manifest }
            : null
          : await this.#pinnedCode(s.extension);
      if (!got) throw new Error(`${s.name}'s extension doesn't ship with this release of Atlas.`);
      const m = got.manifest;
      extension = {
        id: m.id,
        name: m.name,
        version: m.version,
        about: m.about,
        provides: m.provides,
        hosts: reachOf(m),
        secrets: holdsOf(m),
        tools: this.#extTools(m),
        code: got.code,
      };
    }
    const skills: ServicePreview["skills"] = [];
    for (const k of s.skills) {
      const folder = await this.#skillFolder(k);
      skills.push({ name: k.name, md: folder.md, files: folder.files.map((x) => x.path) });
    }
    return { id: s.id, name: s.name, extension, mcp: s.mcp ?? null, skills };
  }

  /**
   * Installs every part of a service: its extension (bundled, or its pinned
   * code, checked again), its MCP server (a sign-in waits for the owner; a
   * key the listing says covers it waits for the key), and its skills. What
   * it can touch was on its card and its preview before this.
   */
  async install(id: string): Promise<string> {
    const s = this.#listed(id);
    const sql = this.d.sql;
    const done: string[] = [];
    if (s.extension) {
      if ("bundled" in s.extension) {
        if (!BUNDLED[s.extension.bundled]) throw new Error(`${s.name}'s extension doesn't ship with this release of Atlas.`);
        install(sql, { id: s.extension.bundled, source: "bundled" });
      } else {
        const was = getExt(sql, s.extension.id);
        const pin = pins(sql)[s.extension.id];
        if (was && (was.source !== "index" || pin?.service !== s.id))
          throw new Error(`An extension called "${s.extension.id}" is already installed from elsewhere; remove it first.`);
        const { code, manifest, methods } = await this.#pinnedCode(s.extension);
        install(sql, { id: manifest.id, source: "index", code, manifest, methods, state: "on" });
        setPin(sql, manifest.id, {
          service: s.id,
          index: s.index,
          code: s.extension.code,
          sha256: s.extension.sha256,
          version: manifest.version,
          at: Date.now(),
        });
      }
      done.push("its extension");
      await this.d.extensionsChanged();
    }
    if (s.mcp) {
      const c = this.d.mcp();
      const servers = c?.servers() ?? [];
      const waitsForKey = s.setup.kind === "key" && s.setup.mcp;
      if (!c) throw new Error("This deployment has no MCP client.");
      // One key covers both parts (§17): when its extension already holds it, the MCP server connects with it too.
      const extId = s.extension ? ("bundled" in s.extension ? s.extension.bundled : s.extension.id) : null;
      const held = s.setup.kind === "key" && s.setup.secret && extId ? extSecrets(sql, extId)[s.setup.secret] : undefined;
      if (!servers.some((x) => sameUrl(x.url, s.mcp!.url)) && waitsForKey && held) {
        const r = await c.add({ name: s.name, url: s.mcp.url, token: held });
        done.push(r.state === "failed" ? "its MCP server, which didn't connect" : "its MCP server, with the key it already has");
      } else if (!servers.some((x) => sameUrl(x.url, s.mcp!.url)) && !waitsForKey && s.mcp.signin !== "token") {
        const r = await c.add({ name: s.name, url: s.mcp.url });
        done.push(r.state === "authenticating" ? "its MCP server, waiting for you to sign in" : "its MCP server");
      } else if (waitsForKey || s.mcp.signin === "token") done.push("its MCP server, once you add the key");
    }
    for (const k of s.skills) {
      const name = await this.#installSkill(s, k);
      done.push(`the ${name} skill`);
    }
    append(sql, { actor: "owner", kind: "settings.change", body: { service: "installed", id: s.id, name: s.name, index: s.index } });
    return `${s.name}: installed ${done.join(", ") || "nothing new"}.`;
  }

  async #installSkill(s: Listed, k: SkillPart): Promise<string> {
    const folder = await this.#skillFolder(k);
    const p = parseSkillMd(folder.md);
    const { skill } = saveSkill(this.d.sql, { ...p, by: "owner", note: `Installed from ${s.name} in the catalog (${host(s.index)}).` });
    if (folder.files.length) {
      const bucket = this.d.files();
      if (!bucket) throw new Error(`${p.name} has files, and this deployment has no bucket for them.`);
      const kept: SkillFile[] = [];
      for (const f of folder.files) {
        await bucket.put(skillFileKey(skill.id, f.path), f.bytes);
        kept.push({ path: f.path, size: f.bytes.length });
      }
      setSkillFiles(this.d.sql, skill.id, kept);
    }
    return skill.name;
  }

  /**
   * The one key that covers a service's parts (§17): kept as its extension's
   * secret, and given to its MCP server as the bearer token (the server is
   * connected again with it).
   */
  async key(id: string, key: string): Promise<string> {
    const s = this.#listed(id);
    if (s.setup.kind !== "key") throw new Error(`${s.name} doesn't take one key; set up each part on its own.`);
    const said: string[] = [];
    const extId = s.extension ? ("bundled" in s.extension ? s.extension.bundled : s.extension.id) : null;
    if (s.setup.secret && extId) {
      if (!getExt(this.d.sql, extId)) await this.install(id);
      setExtSecrets(this.d.sql, extId, { [s.setup.secret]: key });
      said.push("its extension");
      await this.d.extensionsChanged();
    }
    if (s.setup.mcp && s.mcp) {
      const c = this.d.mcp();
      if (!c) throw new Error("This deployment has no MCP client.");
      for (const x of c.servers().filter((x) => sameUrl(x.url, s.mcp!.url))) await c.remove(x.id);
      const r = await c.add({ name: s.name, url: s.mcp.url, token: key });
      said.push(
        r.state === "ready" || r.state === "connected" || r.state === "discovering" ? "its MCP server" : `its MCP server (${r.state})`,
      );
    }
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { service: "key set", id: s.id, name: s.name, parts: said } });
    return `${s.name}'s key is set for ${said.join(" and ")}.`;
  }

  /** Removes what a service installed: its extension (and its secrets), its MCP server, its skills (archived, not deleted). */
  async remove(id: string): Promise<string> {
    const sql = this.d.sql;
    if (id.startsWith("ext:")) {
      const e = uninstall(sql, id.slice(4));
      setPin(sql, id.slice(4), null);
      setPending(sql, id.slice(4), null);
      await this.d.extensionsChanged();
      return e ? `Removed ${e.name}.` : "It was already gone.";
    }
    if (id.startsWith("mcp:")) {
      await this.d.mcp()?.remove(id.slice(4));
      return "Removed the server.";
    }
    const s = this.#listed(id);
    const extId = s.extension ? ("bundled" in s.extension ? s.extension.bundled : s.extension.id) : null;
    if (extId && getExt(sql, extId)) {
      uninstall(sql, extId);
      setPin(sql, extId, null);
      setPending(sql, extId, null);
      await this.d.extensionsChanged();
    }
    const c = this.d.mcp();
    if (s.mcp && c) for (const x of c.servers().filter((x) => sameUrl(x.url, s.mcp!.url))) await c.remove(x.id);
    for (const k of s.skills) {
      const had = findSkill(sql, slug(k.name));
      if (had?.state === "active") setSkillState(sql, had.id, "archived", "owner", `${s.name} was removed.`);
    }
    append(sql, { actor: "owner", kind: "settings.change", body: { service: "removed", id: s.id, name: s.name } });
    return `Removed ${s.name}.`;
  }

  // --- custom ------------------------------------------------------------------------------------------

  /** Custom: an extension from a link, fetched and read by the draft reader; it waits as a draft for the owner to read and install. */
  async link(url: string): Promise<Installed> {
    const code = text(await fetchBytes(this.d.fetch(), url, MAX_CODE_BYTES));
    const d = await this.d.draft(code);
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { extension: "drafted from a link", id: d.id, url } });
    return d;
  }

  // --- the daily look -------------------------------------------------------------------------------------

  async arm(soon = false): Promise<void> {
    const item = armIndex(this.d.sql, Date.now(), soon);
    if (item) await this.d.clock.schedule(item);
  }

  /** Looks at every index, then at updates to code installed from one. The item is leased; it's put back for tomorrow. */
  async look(item: AgendaItem | null): Promise<void> {
    try {
      await this.refresh();
      await this.#updates();
    } finally {
      if (item) finish(this.d.sql, item.id, "done", null, {});
      await this.arm();
    }
  }

  /** Fetches every index now. A failure is kept in the host's words; the copy from before (or the snapshot) stays in use. */
  async refresh(): Promise<void> {
    const f = this.d.fetch();
    for (const url of indexSources(this.d.sql)) {
      try {
        const raw = JSON.parse(text(await fetchBytes(f, url, MAX_INDEX_BYTES))) as unknown;
        const read = readIndex(raw);
        if (url !== DEFAULT_INDEX)
          for (const s of read.index.services)
            if (s.extension && "bundled" in s.extension)
              read.problems.push(`${s.id}: only Atlas's own index may list an extension that ships with Atlas, so it's left out.`);
        noteIndexLook(this.d.sql, url, read);
      } catch (err) {
        const error = err instanceof SyntaxError ? `${host(url)} sent something that isn't JSON.` : errText(err);
        noteIndexLook(this.d.sql, url, { error });
        console.error(JSON.stringify({ at: "services.index", url, error }));
      }
    }
  }

  /**
   * Code installed from an index whose listing now pins something else: it's
   * fetched and checked like an install. One that reaches and holds no more
   * than before is installed; one that would reach or hold more waits for
   * the owner's OK on its card.
   */
  async #updates(): Promise<void> {
    const sql = this.d.sql;
    const listed = catalog(sql);
    for (const [extId, pin] of Object.entries(pins(sql))) {
      // Only the index it came from can update it: another that lists the same id later can't push code into it.
      const s = listed.find((x) => x.id === pin.service && x.index === pin.index);
      const part = s?.extension && "code" in s.extension && s.extension.id === extId ? s.extension : null;
      const e = getExt(sql, extId);
      if (!s || !part || !e || part.sha256 === pin.sha256) continue;
      if (pendingUpdates(sql)[extId]?.sha256 === part.sha256) continue;
      try {
        const next = await this.#pinnedCode(part);
        const widens = widening(e.manifest, next.manifest);
        if (widens.hosts.length || widens.secrets.length || widens.tools.length) {
          setPending(sql, extId, {
            service: s.id,
            index: s.index,
            code: part.code,
            sha256: part.sha256,
            version: next.manifest.version,
            widens,
            at: Date.now(),
          });
          append(sql, {
            actor: "system",
            kind: "settings.change",
            body: { extension: "update waits for your OK", id: extId, name: e.name, version: next.manifest.version, ...widens },
          });
          continue;
        }
        this.#apply(s, part, next, e);
      } catch (err) {
        console.error(JSON.stringify({ at: "services.update", ext: extId, error: errText(err) }));
      }
    }
    await this.d.extensionsChanged();
  }

  #apply(s: Listed, part: PinnedExtension, next: { code: string; manifest: Manifest; methods: string[] }, e: Installed): void {
    install(this.d.sql, {
      id: e.id,
      source: "index",
      code: next.code,
      manifest: next.manifest,
      methods: next.methods,
      state: e.state === "off" ? "off" : "on",
    });
    setPin(this.d.sql, e.id, {
      service: s.id,
      index: s.index,
      code: part.code,
      sha256: part.sha256,
      version: next.manifest.version,
      at: Date.now(),
    });
    setPending(this.d.sql, e.id, null);
    append(this.d.sql, {
      actor: "system",
      kind: "settings.change",
      body: { extension: "updated", id: e.id, name: e.name, from: e.version, to: next.manifest.version },
    });
  }

  /** The owner's yes to an update that reaches or holds more: fetched and checked again, then installed. */
  async update(id: string): Promise<string> {
    const s = this.#listed(id);
    const part = s.extension && "code" in s.extension ? s.extension : null;
    const u = part ? pendingUpdates(this.d.sql)[part.id] : undefined;
    const e = part ? getExt(this.d.sql, part.id) : null;
    if (!part || !u || !e) throw new Error(`${s.name} has no update waiting.`);
    if (u.sha256 !== part.sha256)
      throw new Error(`${s.name}'s listing changed again since; Atlas looks at it again tomorrow, or now with Refresh.`);
    const next = await this.#pinnedCode(part);
    this.#apply(s, part, next, e);
    await this.d.extensionsChanged();
    return `${s.name} is updated to ${next.manifest.version}.`;
  }

  /** The extensions that are on and offer tools, for the model. */
  toolHosts(): Array<{ id: string; name: string; manifest: Manifest; methods: string[] }> {
    return installed(this.d.sql)
      .filter((e) => e.state === "on")
      .map((e) => ({ id: e.id, name: e.name, manifest: e.manifest, methods: methodsOf(e) }));
  }
}
