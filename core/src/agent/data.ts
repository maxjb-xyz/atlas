// Your data (VISION §20, §23.4), on Atlas settings → Account: take a copy of
// everything, go back in time, and delete everything. Each is the owner's
// own act, from the app, never a tool: going back and deleting take a hold
// to confirm, and deleting takes a typed phrase too.
//
// Going back in time is Durable Objects' point-in-time recovery: a bookmark
// for a time in the last 30 days, set to be restored on the next start, then
// a restart. It rewinds this agent's storage only (its SQLite: the log,
// records, settings, secrets, sign-ins), not R2, members' Atlases or the
// workspace. What the restore hands back (a bookmark for just before it) is
// kept in R2, which isn't rewound, so the next start can offer Undo.

import { deletePrefix, keyOf, listFiles } from "../files";
import { type ExportSummary, TarWriter, writeExport } from "../export";
import type { DataView } from "../protocol";
import { listSkills } from "../skills";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { readSettings } from "../store/settings";
import { getState, setState } from "../store/state";
import { shortLocal, zoneOf } from "../time";
import { members } from "../members";
import type { StoredPasskey } from "../passkeys";

/** Durable Objects keep this much history to go back to. */
export const RECOVERY_DAYS = 30;
const DAY_MS = 86_400_000;
/** Kept off the window's far edge, so a time picked there is still inside it when the restore runs. */
const EDGE_MS = 15 * 60_000;
/** What the owner types to delete everything. */
export const DELETE_PHRASE = "delete everything";

/** Point-in-time recovery and a restart: the Durable Object's own, or a fake in tests (the test runtime keeps no history). */
export interface Recovery {
  bookmarkForTime(at: number): Promise<string>;
  /** Returns a bookmark for just before the restore, to undo it. */
  restoreOnNextStart(bookmark: string): Promise<string>;
  restart(why: string): void;
}

interface DataState {
  last_export: { at: number; bytes: number; files: number; problems: string[] } | null;
  export_error: { at: number; text: string } | null;
  /** The last time Atlas went back: to when, when that was, and the bookmark that undoes it. */
  restored: { to: number; at: number; undo: string | null } | null;
}

/** What a restore leaves in R2 for the next start (R2 isn't rewound). */
interface Marker {
  to: number;
  at: number;
  undo: string;
}

export interface DataDeps {
  sql: Sql;
  storage: DurableObjectStorage;
  recovery(): Recovery;
  bucket(): R2Bucket | null;
  /** This agent's name ("owner", "member-…"). */
  name: string;
  member: boolean;
  version(): string;
  mcp(): Array<{ name: string; server_url: string }>;
  secretNames(): string[];
  changed(): void;
  /** For deleting everything, in the owner's Atlas: */
  wipeMember(id: string): Promise<void>;
  wipeWorkspace(): Promise<string[]>;
  takeDownMail(): Promise<string[]>;
  discardHelpers(): Promise<void>;
  /** The owner's Worker's name, when updates found it. */
  script(): string | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class DataDesk {
  constructor(private readonly d: DataDeps) {}

  get #state(): DataState {
    return { last_export: null, export_error: null, restored: null, ...(getState<Partial<DataState>>(this.d.sql, "data") ?? {}) };
  }
  #save(patch: Partial<DataState>): void {
    setState(this.d.sql, "data", { ...this.#state, ...patch });
  }
  get #marker(): string {
    return `restores/${this.d.name}.json`;
  }
  #when(at: number): string {
    return shortLocal(new Date(at), zoneOf(readSettings(this.d.sql)));
  }

  /** On each start of the owner's Atlas: a restore that just happened says so, with its Undo. */
  async start(): Promise<void> {
    const b = this.d.bucket();
    if (this.d.member || !b) return;
    const obj = await b.get(this.#marker);
    if (!obj) return;
    const m = (await obj.json().catch(() => null)) as Marker | null;
    await b.delete(this.#marker);
    if (!m || typeof m.to !== "number") return;
    this.#save({ restored: { to: m.to, at: m.at, undo: m.undo } });
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { went_back_to: m.to, on: m.at } });
    console.log(JSON.stringify({ at: "data.restored", to: m.to, on: m.at }));
    this.d.changed();
  }

  // --- take a copy of everything ------------------------------------------------------------------------

  /** The archive, gzipped, written as it's read; when it ends, the card says how big it was. */
  exportStream(): { name: string; stream: ReadableStream<Uint8Array> } {
    const day = new Date().toISOString().slice(0, 10);
    const root = `atlas-${day}`;
    const gz = new CompressionStream("gzip");
    let bytes = 0;
    let ended!: () => void;
    const flushed = new Promise<void>((r) => (ended = r));
    const count = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        bytes += chunk.byteLength;
        c.enqueue(chunk);
      },
      flush: () => ended(),
    });
    const out = gz.readable.pipeThrough(count);
    const writer = gz.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    const tar = new TarWriter(writer);
    const sql = this.d.sql;
    const done = (async (): Promise<ExportSummary> => {
      const summary = await writeExport(
        tar,
        {
          sql,
          bucket: this.d.bucket(),
          workspaceKey: this.d.member ? null : "workspace/owner.tgz",
          who: !this.d.member && readSettings(sql).owner_name ? `${readSettings(sql).owner_name}'s Atlas` : "your Atlas",
          version: this.d.version(),
          secrets: this.d.secretNames(),
          mcp: this.d.mcp(),
        },
        root,
      );
      await tar.end();
      return summary;
    })();
    // Kept on the card once the last byte has gone through.
    Promise.all([done, flushed]).then(
      ([s]) => {
        this.#save({ last_export: { at: Date.now(), bytes, files: s.files, problems: s.problems.slice(0, 20) }, export_error: null });
        append(sql, { actor: "owner", kind: "settings.change", body: { export: "taken", files: s.files, problems: s.problems.length } });
        this.d.changed();
      },
      async (err: unknown) => {
        const text = `The copy stopped before it was finished: ${errText(err)}`;
        console.error(JSON.stringify({ at: "data.export", error: errText(err) }));
        await writer.abort(err).catch(() => {});
        this.#save({ export_error: { at: Date.now(), text } });
        this.d.changed();
      },
    );
    return { name: `${root}.tar.gz`, stream: out };
  }

  // --- go back in time ----------------------------------------------------------------------------------

  /** The times Atlas can go back to: the last 30 days, and not before it began. */
  window(now = Date.now()): { earliest: number; latest: number } {
    const first = this.d.sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM log`).one().at ?? now;
    return { earliest: Math.max(now - RECOVERY_DAYS * DAY_MS + EDGE_MS, first), latest: now - 60_000 };
  }

  /** What going back to `at` means: what's lost, and what isn't rewound. */
  preview(at: number): { ok: boolean; text: string; lost: string[]; kept: string[] } {
    const sql = this.d.sql;
    const bad = this.#outside(at);
    if (bad) return { ok: false, text: bad, lost: [], kept: [] };
    const count = (q: string, ...args: unknown[]) => {
      try {
        return Number(sql.exec<{ n: number }>(q, ...args).one().n);
      } catch {
        return 0;
      }
    };
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    const messages = count(`SELECT COUNT(*) AS n FROM log WHERE at > ? AND kind IN ('message.in', 'message.out')`, at);
    const other = count(`SELECT COUNT(*) AS n FROM log WHERE at > ? AND kind NOT IN ('message.in', 'message.out')`, at);
    const records = count(`SELECT COUNT(*) AS n FROM records WHERE updated_at > ?`, at);
    const pages = count(`SELECT COUNT(*) AS n FROM pages WHERE updated_at > ?`, at);
    const files = count(`SELECT COUNT(*) AS n FROM files WHERE created_at > ?`, at);
    const skills = count(`SELECT COUNT(*) AS n FROM skills WHERE updated_at > ?`, at);
    const keys = (getState<StoredPasskey[]>(sql, "passkeys") ?? []).filter((p) => p.created_at > at && !p.member).length;
    const invited = members(sql).filter((m) => m.invited_at > at).length;
    const lost = [
      `Everything after ${this.#when(at)} is lost: ${n(messages, "message", "messages")}, and ${n(other, "other thing", "other things")} in the log (actions, changes, deliveries).`,
      ...(records
        ? [`${n(records, "person, place or fact", "people, places and facts")} learned or changed since go back to how they were.`]
        : []),
      ...(pages ? [`${n(pages, "page", "pages")} changed since go back.`] : []),
      ...(skills ? [`${n(skills, "skill", "skills")} changed since go back.`] : []),
      ...(files ? [`${n(files, "file", "files")} made since stay in your files store, but Atlas won't list them.`] : []),
      ...(keys ? [`${n(keys, "passkey", "passkeys")} added since are forgotten: sign in with an older one or your setup code.`] : []),
      ...(invited ? [`${n(invited, "member", "members")} invited since are forgotten, and can't sign in.`] : []),
      "Keys, sign-ins and settings go back too, so a sign-in made or refreshed since (ChatGPT, Google) may need doing again.",
    ];
    const kept = [
      "Files and the workspace aren't rewound: a file deleted since is listed again, but can't be opened.",
      "Members' own Atlases stay as they are.",
      "What Atlas did outside stays done: mail it sent, events it moved, messages on chats.",
      "If you signed in on this device after then, you sign in again.",
    ];
    return { ok: true, text: `Going back to ${this.#when(at)}.`, lost, kept };
  }

  #outside(at: number): string | null {
    if (this.d.member) return "Going back in time is done in the owner's Atlas.";
    const w = this.window();
    if (!Number.isFinite(at)) return "Pick a time to go back to.";
    if (at > w.latest) return "Pick a time in the past.";
    if (at < w.earliest)
      return `Atlas can go back to ${this.#when(w.earliest)} at the earliest: Cloudflare keeps ${RECOVERY_DAYS} days of history${w.earliest > Date.now() - RECOVERY_DAYS * DAY_MS + EDGE_MS ? ", and this Atlas began then" : ""}.`;
    return null;
  }

  /**
   * Sets the restore for the next start and keeps its Undo in R2. The caller
   * answers the app, then restarts. `undo` goes back to just before the
   * last time Atlas went back.
   */
  async restore(o: { at?: number; undo?: boolean; hold: boolean }): Promise<{ ok: boolean; text: string }> {
    if (this.d.member) return { ok: false, text: "Going back in time is done in the owner's Atlas." };
    if (!o.hold) return { ok: false, text: "Going back in time can't be undone from Cloudflare's side, so it takes a hold to confirm." };
    const rec = this.d.recovery();
    let bookmark: string;
    let to: number;
    if (o.undo) {
      const r = this.#state.restored;
      if (!r?.undo) return { ok: false, text: "There's no going back to undo." };
      if (Date.now() - r.at > RECOVERY_DAYS * DAY_MS - EDGE_MS)
        return { ok: false, text: `That was more than ${RECOVERY_DAYS} days ago, past what Cloudflare keeps.` };
      bookmark = r.undo;
      to = r.at;
    } else {
      const bad = this.#outside(o.at ?? Number.NaN);
      if (bad) return { ok: false, text: bad };
      to = o.at!;
      try {
        bookmark = await rec.bookmarkForTime(to);
      } catch (err) {
        console.error(JSON.stringify({ at: "data.restore", step: "bookmark", to, error: errText(err) }));
        return { ok: false, text: `Cloudflare didn't give a point to go back to: ${errText(err)}` };
      }
    }
    let undo: string;
    try {
      undo = await rec.restoreOnNextStart(bookmark);
    } catch (err) {
      console.error(JSON.stringify({ at: "data.restore", step: "restore", to, error: errText(err) }));
      return { ok: false, text: `Cloudflare didn't take the restore: ${errText(err)}` };
    }
    let note = "";
    const b = this.d.bucket();
    try {
      if (!b) throw new Error("there's no files store (the FILES bucket)");
      await b.put(this.#marker, JSON.stringify({ to, at: Date.now(), undo } satisfies Marker), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (err) {
      note = ` Undo won't be offered afterwards: ${errText(err)}.`;
      console.error(JSON.stringify({ at: "data.restore", step: "marker", error: errText(err) }));
    }
    console.log(JSON.stringify({ at: "data.restore", to, undo: Boolean(o.undo) }));
    return {
      ok: true,
      text: `${o.undo ? "Undoing going back: back to" : "Going back to"} ${this.#when(to)}. Atlas restarts there in a moment.${note}`,
    };
  }

  // --- delete everything ----------------------------------------------------------------------------------

  /** Deletes this agent's own data: its files and skills' files in R2, its helpers, then all of its storage. */
  async wipeOwn(): Promise<string[]> {
    const problems: string[] = [];
    const b = this.d.bucket();
    if (b) {
      try {
        const keys = [...listFiles(this.d.sql).map(keyOf), this.#marker];
        for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000));
        for (const s of listSkills(this.d.sql, { all: true })) await deletePrefix(b, `skills/${s.id}/`);
      } catch (err) {
        problems.push(`Some files are still in the files store (R2 said: ${errText(err)}): delete the bucket to be sure they're gone.`);
      }
    }
    try {
      await this.d.discardHelpers();
    } catch (err) {
      problems.push(`A helper's own storage couldn't be deleted: ${errText(err)}`);
    }
    await this.d.storage.deleteAll();
    return problems;
  }

  /** What's still there after deleting everything, and how to remove it. */
  #left(): string[] {
    const script = this.d.script();
    const tokens = this.d.secretNames().filter((n) => n === "cf_update_token" || n === "cf_mail_token");
    return [
      `Your Worker${script ? ` "${script}"` : ""} and its secrets (ATLAS_OWNER_SECRET, ATLAS_DATA_KEY) stay on Cloudflare: Workers & Pages → your Atlas → Settings → Delete removes them.`,
      "The files store, the R2 bucket atlas-files, stays, without what Atlas kept: R2 → atlas-files → Settings → Delete bucket removes it.",
      `Cloudflare keeps ${RECOVERY_DAYS} days of the storage's history for going back in time, so until then what was deleted may still be brought back from your Cloudflare account.`,
      ...(tokens.length
        ? [
            `The Cloudflare tokens you made for Atlas (${tokens.map((t) => (t === "cf_update_token" ? "updates" : "Atlas's email")).join(", ")}) still work until you delete them: My Profile → API Tokens.`,
          ]
        : []),
      "Services you connected keep their side (a chat bot, a sign-in, an app you allowed): remove Atlas there if you like.",
      "Your passkeys stay in your devices' password managers, opening nothing. Your setup code signs you in to a new, empty Atlas.",
    ];
  }

  /**
   * Deletes everything (§23.4): Atlas's mail relay, every member's Atlas,
   * the workspace and its copies, Library's files, then all of this
   * agent's storage (the log, records, settings, secrets, passkeys and
   * sign-ins). Only the owner, from the app, with the phrase and a hold.
   * The caller answers the app, closes every socket and restarts.
   */
  async deleteEverything(o: { phrase: string; hold: boolean }): Promise<{ ok: boolean; text: string; left: string[] }> {
    if (this.d.member) return { ok: false, text: "Only the owner can delete everything.", left: [] };
    if (!o.hold) return { ok: false, text: "Deleting everything can't be undone, so it takes a hold to confirm.", left: [] };
    if (o.phrase.trim().toLowerCase() !== DELETE_PHRASE) return { ok: false, text: `Type "${DELETE_PHRASE}" first.`, left: [] };
    const left = this.#left();
    const problems: string[] = [];
    const sql = this.d.sql;
    console.log(JSON.stringify({ at: "data.delete", step: "start", members: members(sql).length }));
    if (getState(sql, "atlas_mail"))
      try {
        for (const n of await this.d.takeDownMail())
          problems.push(`Atlas's mail relay: ${n} Delete it in the domain's Cloudflare account.`);
      } catch (err) {
        problems.push(`Atlas's mail relay couldn't be taken down: ${errText(err)} Delete it in the domain's Cloudflare account.`);
      }
    for (const m of members(sql))
      try {
        await this.d.wipeMember(m.id);
      } catch (err) {
        problems.push(`${m.name}'s Atlas couldn't be deleted: ${errText(err)}`);
      }
    try {
      problems.push(...(await this.d.wipeWorkspace()));
    } catch (err) {
      problems.push(`The workspace couldn't be deleted: ${errText(err)}`);
    }
    problems.push(...(await this.wipeOwn()));
    console.log(JSON.stringify({ at: "data.delete", step: "done", problems }));
    return {
      ok: true,
      text: "Everything Atlas kept is deleted. It starts again empty; your setup code signs you in to set it up.",
      left: [...problems, ...left],
    };
  }

  // --- the card -------------------------------------------------------------------------------------------

  view(): DataView {
    const s = this.#state;
    const w = this.window();
    const sql = this.d.sql;
    return {
      last_export: s.last_export,
      export_error: s.export_error,
      restore: this.d.member
        ? null
        : {
            earliest: w.earliest,
            latest: w.latest,
            restored: s.restored ? { to: s.restored.to, at: s.restored.at, undo: Boolean(s.restored.undo) } : null,
          },
      delete: this.d.member
        ? null
        : {
            phrase: DELETE_PHRASE,
            members: members(sql).map((m) => m.name),
            left: this.#left(),
          },
    };
  }
}
