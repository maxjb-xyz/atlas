// The extension desk (VISION §17): what the agent does with extensions. It
// installs and removes them, keeps their settings and secrets, runs their
// setup, sign-in and tests for Settings, takes their posts, asks the ones
// that look what's new on the one clock, and hands what comes back to the
// core: items to the intake, fixes to location, messages to the channels.
// It also moves what M4 built into the core out to bundled extensions, once.

import { callData } from "./calls";
import { z } from "zod";
import type { Card, Json, Manifest, Message, Received, Request as ExtRequest } from "../../../extensions/sdk";
import { BUNDLED } from "../extensions.gen";
import {
  accountName,
  armLooks,
  codeOf,
  manyAccounts,
  type ExtensionHost,
  extSecrets,
  getExt,
  type Installed,
  install,
  installed,
  methodsOf,
  nextLooks,
  noteExt,
  postAllowed,
  saveCursor,
  saveData,
  setExtSecrets,
} from "../extensions";
import { noteSource, type SenseItem } from "../intake";
import { ownerLearned, parseVCards, importCards, senderSeen } from "../contacts";
import { fromBase64, fromDataUrl, keepPhoto, keptPhoto, photoSource } from "../photos";
import { allowedPost, here, observations, type Observation, pins, refused } from "../location";
import type { AgendaItem } from "../store/agenda";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { getSecret, readSettings, setSecret, writeSettings } from "../store/settings";
import { getState, setState } from "../store/state";
import type { ToolContext } from "../tools/types";
import type { ExtensionView } from "../protocol";
import { Icon } from "../services";
import { EXT_ASKS, heldAs, ToolsShape } from "../tools/extensions";

export interface ExtensionDeps {
  sql: Sql;
  host: ExtensionHost;
  clock: ToolContext["clock"];
  /** Items for the intake. */
  take(items: SenseItem[], o?: { raw?: string; refresh?: boolean }): void;
  /** Where the owner is changed: the observations go through the location state machine into the intake. */
  location(obs: Observation[]): void;
  /** Messages that came in on a channel extension. */
  messages(e: Installed, msgs: Message[]): Promise<void>;
  /** What Settings shows changed. */
  changed(): void;
  origin(): string | null;
  /** Where contacts' photos are kept (R2's FILES bucket), when there is one. */
  bucket(): R2Bucket | null;
  /** Work that goes on after the call that started it has answered. */
  background(fn: () => Promise<void>): void;
  /** Records changed outside a run (contacts' photos came in): the app reads them again. */
  recordsChanged(): void;
}

/** The most photos one import of an address book reads. */
const MAX_PHOTOS = 1_000;

/** What the manifest of an extension that doesn't ship with Atlas (a draft, a link, an index's) must look like before it's kept. */
export const ManifestShape = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    name: z.string().min(1).max(60),
    version: z.string().min(1).max(20),
    about: z.string().min(1).max(400),
    icon: Icon.optional(),
    provides: z
      .array(z.enum(["sense", "channel", "mail", "sending", "calendar", "contacts", "location", "maps", "weather", "search", "tools"]))
      .min(1),
    hosts: z.array(z.string().min(3).max(120)).max(20),
    tools: ToolsShape.optional(),
  })
  .refine((m) => !m.provides.includes("tools") || (m.tools ?? []).length > 0, "it provides tools, so it needs `tools`")
  .refine(
    (m) => (m.tools ?? []).every((t) => `ext_${m.id}_${t.name}`.length <= 64),
    "a tool's name with its extension's id is over 64 characters",
  );

export class ExtensionDesk {
  constructor(private readonly d: ExtensionDeps) {}

  // --- Settings -----------------------------------------------------------------------------------------

  views(): ExtensionView[] {
    const origin = this.d.origin();
    const mine = installed(this.d.sql);
    const have = new Set(mine.map((e) => e.id));
    const view = (m: Manifest, e: Installed | null, source: ExtensionView["source"], methods: string[]): ExtensionView => {
      const secrets = e ? extSecrets(this.d.sql, e.id) : {};
      return {
        id: e?.id ?? m.id,
        name: m.name,
        account: e ? accountName(e) : null,
        many: manyAccounts(m),
        version: m.version,
        about: m.about,
        provides: m.provides,
        hosts: m.hosts,
        tools: (m.tools ?? []).map((t) => {
          const kind = heldAs(t, m.tools ?? [], m.id);
          return { name: t.name, description: t.description, kind, asks: EXT_ASKS[kind].asks };
        }),
        credit: m.credit ?? null,
        costs: m.costs ?? null,
        source,
        state: e ? e.state : "available",
        secrets: (m.secrets ?? []).map((s) => ({
          name: s.name,
          label: s.label,
          help: s.help ?? "",
          optional: Boolean(s.optional),
          set: Boolean(secrets[s.name]),
        })),
        settings: [
          ...(m.settings ?? []).map((s) => ({
            name: s.name,
            label: s.label,
            help: s.help ?? "",
            optional: Boolean(s.optional),
            value: e?.settings[s.name] ?? s.default ?? "",
          })),
          ...(m.signin
            ? [
                {
                  name: "client_id",
                  label: "Client ID",
                  help: "From the sign-in client you made.",
                  optional: false,
                  value: e?.settings.client_id ?? "",
                },
              ]
            : []),
        ],
        signin: m.signin
          ? {
              help: m.signin.help,
              redirect: origin ? `${origin}/x/signin` : null,
              signed_in: Boolean(secrets.refresh_token || secrets.access_token),
              secret_set: Boolean(secrets.client_secret),
            }
          : null,
        every: m.every ?? null,
        address: e && m.receives ? (this.d.host.address(e) ?? null) : null,
        ok_at: e?.ok_at ?? null,
        error: e?.error ?? null,
        error_at: e?.error_at ?? null,
        last_look: e?.last_look ?? null,
        methods,
        code: e && e.source !== "bundled" ? e.code : null,
      };
    };
    return [
      ...mine.map((e) => view(e.manifest, e, e.source, methodsOf(e))),
      ...Object.values(BUNDLED)
        .filter((b) => !have.has(b.manifest.id))
        .map((b) => view(b.manifest, null, "bundled", b.methods)),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  async install(id: string): Promise<void> {
    const e = getExt(this.d.sql, id);
    if (e?.state === "draft") {
      // The owner's Install on a draft is their OK for it.
      this.d.sql.exec(`UPDATE extensions SET state = 'on', updated_at = ? WHERE id = ?`, Date.now(), id);
      append(this.d.sql, {
        actor: "owner",
        kind: "settings.change",
        body: { extension: "installed", name: e.name, id, written_by: e.source },
      });
    } else install(this.d.sql, { id, source: "bundled" });
    await this.arm();
    this.d.changed();
  }

  async afterChange(): Promise<void> {
    await this.arm();
    this.d.changed();
  }

  /** A live check for Settings: the extension's own test, in its own words. What it learned about the owner goes on their record. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const e = getExt(this.d.sql, id);
    if (!e) return { ok: false, message: "That extension isn't installed." };
    if (!methodsOf(e).includes("test")) return { ok: true, message: `${e.name} has nothing to test; it works when it's called.` };
    try {
      const r = await this.d.host.call<{ text: string; owner?: { emails?: string[] } }>(id, "test", [], { any: true });
      noteExt(this.d.sql, id);
      if (r.owner?.emails?.length) ownerLearned(this.d.sql, r.owner.emails, e.name);
      return { ok: true, message: r.text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteExt(this.d.sql, id, message);
      return { ok: false, message };
    } finally {
      this.d.changed();
    }
  }

  /** Runs an extension's setup, and gives back what it says to show once (a link, a password). */
  async setup(id: string): Promise<{ ok: boolean; text: string; link?: string; fields?: Array<{ label: string; value: string }> }> {
    const e = getExt(this.d.sql, id);
    if (!e) return { ok: false, text: "That extension isn't installed." };
    if (!methodsOf(e).includes("setup")) return { ok: true, text: `${e.name} needs no setup.` };
    if (e.manifest.receives && !this.d.origin())
      return { ok: false, text: "Open Atlas in the browser once first, so it knows its own address." };
    try {
      const r = await this.d.host.call<{ text: string; link?: string; fields?: Array<{ label: string; value: string }> }>(id, "setup", [], {
        data: this.#dataFor(e),
      });
      noteExt(this.d.sql, id);
      append(this.d.sql, { actor: "owner", kind: "settings.change", body: { extension: "set up", name: e.name, id } });
      return { ok: true, ...r };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      noteExt(this.d.sql, id, text);
      return { ok: false, text };
    } finally {
      this.d.changed();
    }
  }

  /** What the core shares with an extension for what it provides: the owner's saved places, for a location app. */
  #dataFor(e: Installed): Json | undefined {
    if (e.manifest.provides.includes("location")) return { places: pins(this.d.sql) as unknown as Json };
    if (e.manifest.provides.includes("calls")) return callData(this.d.sql, this.d.host.address(e)) as unknown as Json;
    return undefined;
  }

  /**
   * Keeps what Atlas (or the owner) wrote as a draft: its code, read in a
   * sandbox with no way out to find its manifest and calls. It doesn't run
   * until the owner installs it in Settings.
   */
  async draft(code: string, by: "atlas" | "owner"): Promise<Installed> {
    const { manifest, methods } = await this.d.host.describe(code);
    const m = ManifestShape.safeParse(manifest);
    if (!m.success)
      throw new Error(`The manifest isn't right: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (BUNDLED[manifest.id]) throw new Error(`"${manifest.id}" is the id of an extension that ships with Atlas; pick another.`);
    const was = getExt(this.d.sql, manifest.id);
    // A draft never replaces an installed extension: it would take that one's keys for hosts nobody approved with them.
    if (was && was.state !== "draft") throw new Error(`"${manifest.id}" is already installed; pick another id, or remove that one first.`);
    return install(this.d.sql, { id: manifest.id, source: by, code, manifest, methods, state: "draft" });
  }

  // --- posts ---------------------------------------------------------------------------------------------

  /** A post to an extension's own address. The answer is the extension's, after the core checked the key and signature. */
  async post(id: string, key: string, req: ExtRequest): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const e = getExt(this.d.sql, id);
    const json = (status: number, body: unknown) => ({
      status,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    if (!e || !e.manifest.receives) return json(404, { error: "There's no extension taking posts here." });
    const why = await postAllowed(this.d.sql, e, key, req);
    if (why) {
      noteExt(this.d.sql, id, `Refused a post: ${why}.`);
      noteSource(this.d.sql, id, `Refused a post: ${why}.`);
      console.error(JSON.stringify({ at: `ext.${id}.post`, error: why }));
      this.d.changed();
      return json(401, { error: `Refused: ${why}.` });
    }
    return this.#receive(e, req, id);
  }

  /** The location app's old address (/owntracks), from before it was an extension: the same post, without a key in the address. */
  async legacyLocation(req: ExtRequest): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const e = installed(this.d.sql).find(
      (x) => x.state === "on" && x.manifest.provides.includes("location") && methodsOf(x).includes("receive"),
    );
    if (!e)
      return {
        status: 404,
        body: JSON.stringify({ error: "No location extension is on. Settings → Extensions." }),
        headers: { "content-type": "application/json" },
      };
    return this.#receive(e, req, e.id);
  }

  /**
   * A post to one of the owner's general webhook sources that an extension
   * claims by its headers (GitHub's X-GitHub-Event). The source's own key
   * was checked; the extension reads it into items. False when none claims it.
   */
  async claimed(req: ExtRequest, hook: { id: string; name: string }): Promise<boolean> {
    const e = installed(this.d.sql).find(
      (x) =>
        x.state === "on" &&
        methodsOf(x).includes("receive") &&
        (x.manifest.receives?.claims ?? []).some((h) => req.headers[h.toLowerCase()] != null),
    );
    if (!e) return false;
    await this.#receive(e, req, `webhook:${hook.name}`, hook);
    return true;
  }

  async #receive(
    e: Installed,
    req: ExtRequest,
    source: string,
    hook?: { id: string; name: string },
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    let r: Received;
    try {
      r = await this.d.host.call<Received>(e.id, "receive", [req], { data: this.#dataFor(e) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteExt(this.d.sql, e.id, message);
      noteSource(this.d.sql, source, message);
      console.error(JSON.stringify({ at: `ext.${e.id}.receive`, error: message }));
      return { status: 500, body: JSON.stringify({ error: message }), headers: { "content-type": "application/json" } };
    }
    const status = r.reply?.status ?? 200;
    const location = e.manifest.provides.includes("location");
    if (status === 401) {
      noteExt(this.d.sql, e.id, "Refused a post with the wrong sign-in.");
      if (location) refused(this.d.sql);
      console.error(JSON.stringify({ at: `ext.${e.id}.receive`, error: "wrong sign-in" }));
    } else {
      noteExt(this.d.sql, e.id);
      if (location) {
        allowedPost(this.d.sql);
        // With location off, what the phone sends is dropped (§10.1).
        if (readSettings(this.d.sql).location.on) this.d.location(observations(r));
      }
      this.#items(e, r.items ?? [], source, hook);
      if (r.messages?.length) await this.d.messages(e, r.messages);
    }
    this.d.changed();
    const headers = { ...(r.reply?.headers ?? {}) };
    if (r.reply?.json !== undefined)
      return { status, body: JSON.stringify(r.reply.json), headers: { "content-type": "application/json", ...headers } };
    return { status, body: r.reply?.body ?? "", headers };
  }

  /** An extension's items into the intake, each with what it sent kept aside as raw content. */
  #items(e: Installed, items: Received["items"] & object, source: string, hook?: { id: string; name: string }): void {
    if (!items.length) return;
    noteSource(this.d.sql, source);
    for (const it of items.slice(0, 50)) {
      const { raw, ...rest } = it;
      // A post to a webhook source stays that source's, read by the extension that claimed it.
      const by = { ext: e.id, ext_name: e.manifest.name };
      // Who wrote: someone Atlas knows, or a new person learned from it (§7.1). Only mail and chats are people writing.
      const writer = e.manifest.provides.includes("mail")
        ? senderSeen(this.d.sql, rest, `mail via ${e.manifest.name}`)
        : e.manifest.provides.includes("channel")
          ? senderSeen(this.d.sql, rest, e.manifest.name, "telegram")
          : {};
      const said = writer.same_name
        ? {
            what: `${rest.what} (from an address not on the record of ${writer.same_name.name}, whom you know; contact_save joins them if it's them)`,
          }
        : {};
      const item = (hook
        ? { ...rest, ...said, source: "webhook", hook, ...by }
        : { ...rest, ...said, source, ...by, ...writer }) as unknown as SenseItem;
      this.d.take([item], raw ? { raw } : {});
    }
  }

  // --- the looks on the clock ------------------------------------------------------------------------

  /** Puts the extensions' look on the clock at the soonest one's time, or takes it off when none looks. */
  /** `ending` is the look itself, putting itself back when it's done; anything else leaves a look under way alone. */
  async arm(ending = false): Promise<void> {
    const { item, cancel } = armLooks(this.d.sql, Date.now(), ending);
    if (cancel) await this.d.clock.unschedule(cancel);
    if (item) await this.d.clock.schedule(item);
  }

  /** The look came due (the item is leased): each extension that's due is asked what's new since its cursor. */
  async looks(_item: AgendaItem): Promise<void> {
    try {
      for (const e of nextLooks(this.d.sql).due) await this.#look(e);
    } finally {
      await this.arm(true);
    }
  }

  async #look(e: Installed): Promise<void> {
    try {
      const r = await this.d.host.call<{ items: Received["items"]; cursor: Json }>(e.id, "look", [], { ms: 45_000 });
      saveCursor(this.d.sql, e.id, r.cursor ?? e.cursor);
      noteExt(this.d.sql, e.id);
      noteSource(this.d.sql, e.id);
      this.#items(e, r.items ?? [], e.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The cursor stays; the time moves on, so a failing service is asked again at its interval, not at once.
      saveCursor(this.d.sql, e.id, e.cursor);
      noteExt(this.d.sql, e.id, message);
      noteSource(this.d.sql, e.id, message);
      console.error(JSON.stringify({ at: `ext.${e.id}.look`, error: message }));
    }
  }

  // --- contacts ---------------------------------------------------------------------------------------

  /** Brings the address book in from an extension that provides contacts, or from a vCard file's text. */
  async importContacts(o: { from: string } | { vcards: string }): Promise<{ ok: boolean; text: string }> {
    let cards: Card[];
    let via: string;
    let e: Installed | null = null;
    if ("vcards" in o) {
      cards = parseVCards(o.vcards);
      via = "a vCard file";
    } else {
      e = getExt(this.d.sql, o.from);
      if (!e) return { ok: false, text: "That extension isn't installed." };
      try {
        const r = await this.d.host.call<{ vcards?: string; cards?: Card[] }>(o.from, "contacts", [], { ms: 60_000 });
        noteExt(this.d.sql, o.from);
        via = `${e.name} contacts`;
        cards = r.cards ?? parseVCards(r.vcards ?? "");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        noteExt(this.d.sql, o.from, message);
        return { ok: false, text: message };
      }
    }
    const photos: Array<{ id: string; photo: string }> = [];
    const out = this.#imported(importCards(this.d.sql, cards, via, photos), via);
    // Photos come after the people, so the import answers at once; only ones that changed are read.
    if (photos.length) this.d.background(() => this.#keepPhotos(photos, e));
    return out;
  }

  #imported(out: { added: number; merged: number; same: number; skipped: number }, via: string): { ok: boolean; text: string } {
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { contacts: "imported", via, ...out } });
    this.d.changed();
    return {
      ok: true,
      text: `From ${via}: ${out.added} added, ${out.merged} merged with people Atlas knew, ${out.same} already known${out.skipped ? `, ${out.skipped} with no way to reach them left out` : ""}.`,
    };
  }

  /**
   * Keeps the address book's photos (docs/ui §8): one in the card as it is,
   * one at an address from the extension that gave the card, a few at a
   * time. One that can't be kept is noted on the extension, in its words.
   */
  async #keepPhotos(list: Array<{ id: string; photo: string }>, e: Installed | null): Promise<void> {
    const bucket = this.d.bucket();
    if (!bucket) return;
    const fetches = e ? methodsOf(e).includes("photo") : false;
    const failed: string[] = [];
    let kept = 0;
    const one = async (p: { id: string; photo: string }) => {
      const src = await photoSource(p.photo);
      if (keptPhoto(this.d.sql, p.id)?.src === src) return;
      try {
        let bytes: Uint8Array | null;
        if (p.photo.startsWith("data:")) bytes = fromDataUrl(p.photo);
        else if (e && fetches)
          bytes = fromBase64((await this.d.host.call<{ base64: string }>(e.id, "photo", [p.photo], { ms: 20_000 })).base64);
        else return;
        if (!bytes) throw new Error("it isn't base64");
        await keepPhoto(this.d.sql, bucket, p.id, bytes, src);
        kept += 1;
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    };
    const queue = list.slice(0, MAX_PHOTOS);
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) await one(p);
      }),
    );
    if (failed.length) {
      const text = `${failed.length} contact ${failed.length === 1 ? "photo" : "photos"} couldn't be kept; the first: ${failed[0]}`;
      console.error(JSON.stringify({ at: "contacts.photos", ext: e?.id ?? "vcard", failed: failed.length, error: failed[0] }));
      if (e) noteExt(this.d.sql, e.id, text);
    }
    if (kept) this.d.recordsChanged();
  }

  // --- moving M4's providers out of the core (once) ---------------------------------------------------------

  /**
   * Once, on the first start of this release: what M4 kept in the core is
   * installed as the bundled extensions that do it now, with the owner's
   * keys, logins and copies moved over and the old ones forgotten, so a
   * deployment from before works as it did with no step from the owner.
   * OpenStreetMap and Open-Meteo are installed for everyone, since they're
   * the defaults and cost nothing.
   */
  async upgrade(): Promise<void> {
    if (getState(this.d.sql, "extensions_moved")) return;
    const sql = this.d.sql;
    const moved: string[] = [];
    const add = (id: string, o: { settings?: Record<string, string>; secrets?: Record<string, string>; data?: Json } = {}) => {
      if (!BUNDLED[id]) return;
      install(sql, { id, source: "bundled", ...(o.settings ? { settings: o.settings } : {}) });
      if (o.secrets && Object.keys(o.secrets).length) setExtSecrets(sql, id, o.secrets);
      if (o.data !== undefined) saveData(sql, id, o.data);
      moved.push(id);
    };
    add("osm");
    add("open-meteo");
    const settings = readSettings(sql);
    const mapbox = getSecret<string>(sql, "mapbox_token");
    if (mapbox || settings.maps.provider === "mapbox") add("mapbox", mapbox ? { secrets: { token: mapbox } } : {});
    for (const id of ["tavily", "brave", "exa"] as const) {
      const key = getSecret<string>(sql, `${id}_api_key`);
      if (key || settings.web.search === id) add(id, key ? { secrets: { key } } : {});
      setSecret(sql, `${id}_api_key`, null);
    }
    setSecret(sql, "mapbox_token", null);
    const icloud = getSecret<{ username?: string; app_password?: string }>(sql, "icloud");
    if (icloud?.username) {
      add("icloud", {
        settings: { username: icloud.username },
        secrets: icloud.app_password ? { app_password: appPassword(icloud.app_password) } : {},
        data: (getState<Json>(sql, "icloud_copy") ?? null) as Json,
      });
      ownerLearned(sql, [icloud.username], "iCloud");
      setSecret(sql, "icloud", null);
      setState(sql, "icloud_copy", null);
    }
    const owntracks = getSecret<{ user: string; password: string; made_at: number }>(sql, "owntracks");
    if (owntracks) {
      add("owntracks", { data: { ...owntracks, regions: here(sql).regions ?? "" } as unknown as Json });
      setSecret(sql, "owntracks", null);
    }
    // Webhook sources that GitHub or Linear posted to: their extensions read those posts now.
    const posted = (word: string) =>
      sql
        .exec(
          `SELECT 1 FROM log WHERE kind = 'sense' AND json_extract(body, '$.source') = 'webhook' AND json_extract(body, '$.what') LIKE ? LIMIT 1`,
          `${word}:%`,
        )
        .toArray().length > 0;
    if (posted("GitHub")) add("github");
    if (posted("Linear")) add("linear");
    setState(sql, "extensions_moved", { at: Date.now(), moved });
    append(sql, { actor: "system", kind: "settings.change", body: { extensions: "moved out of the core", ids: moved } });
    await this.arm();
  }

  /** The bundled extensions every new Atlas starts with, for a write of Settings that names a provider. */
  ensureProvider(kind: "maps" | "search", id: string): void {
    if (kind === "search" && id === "cloudflare") return;
    if (!getExt(this.d.sql, id) && BUNDLED[id]) install(this.d.sql, { id, source: "bundled" });
    if (kind === "maps") writeSettings(this.d.sql, { maps: { provider: id } });
  }

  codeOf(id: string): string | null {
    const e = getExt(this.d.sql, id);
    return e ? codeOf(e) : (BUNDLED[id]?.code ?? null);
  }
}

/** An app-specific password as Apple shows it (xxxx-xxxx-xxxx-xxxx), however it was pasted. */
function appPassword(p: string): string {
  const letters = p.replace(/[\s-]+/g, "");
  return /^[a-z]{16}$/i.test(letters) ? (letters.toLowerCase().match(/.{4}/g) ?? []).join("-") : p.replace(/\s+/g, "");
}
