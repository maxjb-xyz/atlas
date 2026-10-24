// The updates desk (VISION §23.2): the daily look at Atlas's releases on the
// clock, the token Updates uses, and Update and Roll back, each step kept
// in Cloudflare's own words for the Updates card (Atlas settings → Account).
// An update's deployment restarts Atlas on the new version, so its outcome is
// settled on the next start, by the version Cloudflare runs then.

import { CloudflareError } from "../atlasmail";
import type { UpdatesView } from "../protocol";
import { fetchBytes } from "../services";
import { type AgendaItem, finish } from "../store/agenda";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { getSecret, setSecret } from "../store/settings";
import type { ToolContext } from "../tools/types";
import {
  armUpdates,
  blockers,
  BUNDLE_ASSET,
  current,
  deploy,
  DEPLOY_WAIT_MS,
  fetchManifest,
  fetchReleases,
  findTarget,
  isNewer,
  openBundle,
  type Running,
  saveUpdates,
  SECRET_CHANGED,
  sourceWords,
  type Step,
  type UpdateRun,
  updatesState,
  updateTokenLink,
  uploadAssets,
  uploadVersion,
  versionDetail,
} from "../updates";

export interface UpdateDeps {
  sql: Sql;
  fetch(): typeof fetch;
  clock: ToolContext["clock"];
  /** Which Atlas is running: the app's build and Cloudflare's version id. */
  running(): Promise<Running>;
  /** The app's address, for a first guess at the Worker's name (its workers.dev label). */
  origin(): string | null;
  /** The Updates card changed. */
  changed(): void;
}

const MAX_BUNDLE_BYTES = 100_000_000;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "unknown");
const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

export class UpdateDesk {
  #running: Running | null = null;
  #busy = false;
  constructor(private readonly d: UpdateDeps) {}

  running(): Running {
    return this.#running ?? { version: "unknown", commit: null, version_id: null };
  }

  /** On each start: learn which Atlas this is, settle an update or rollback a restart cut off, and arm the daily look. */
  async start(): Promise<void> {
    try {
      this.#running = await this.d.running();
    } catch (err) {
      console.error(JSON.stringify({ at: "updates.running", error: errText(err) }));
    }
    this.settle();
    await this.arm(true);
  }

  async arm(soon = false): Promise<void> {
    const item = armUpdates(this.d.sql, Date.now(), soon);
    if (item) await this.d.clock.schedule(item);
  }

  /**
   * Settles the last update or rollback by what runs now: the version it
   * deployed means it worked; still the old one after a while, or another
   * one, means it didn't, and says so. A run cut off before its deployment
   * deployed nothing. Then notices a version Atlas didn't install.
   */
  settle(now = Date.now()): void {
    const sql = this.d.sql;
    const s = updatesState(sql);
    const r = this.running();
    const last = s.last;
    const end = (run: UpdateRun, state: UpdateRun["state"], ok: boolean, text: string): UpdateRun => ({
      ...run,
      state,
      ended_at: now,
      steps: [...run.steps, { what: "confirm", ok, text, at: now }],
    });
    if (last?.state === "running") {
      const at = last.steps.at(-1)?.what ?? "check";
      saveUpdates(sql, {
        last: end(last, "failed", false, `Atlas restarted partway through (after the ${at} step), so nothing was deployed. Try again.`),
      });
      return;
    }
    if (last?.state === "deploying" && r.version_id) {
      if (r.version_id === last.to_version) {
        saveUpdates(sql, {
          last: end(last, "done", true, `Atlas is running ${last.label} now (version ${short(r.version_id)}).`),
          installed: { version_id: r.version_id, label: last.label, at: now },
          foreign: null,
          ...(last.kind === "rollback" ? { previous: null } : {}),
        });
        append(sql, { actor: "system", kind: "settings.change", body: { [last.kind]: last.label, version: r.version_id, done: true } });
        return;
      }
      if (r.version_id !== last.from_version) {
        saveUpdates(sql, {
          last: end(
            last,
            "failed",
            false,
            `Atlas runs version ${short(r.version_id)} now, not the one this put in. Workers & Pages → your Atlas → Deployments shows what happened.`,
          ),
        });
        return;
      }
      const sent = last.steps.at(-1)?.at ?? last.started_at;
      if (now - sent > DEPLOY_WAIT_MS)
        saveUpdates(sql, {
          last: end(
            last,
            "failed",
            false,
            `Cloudflare took the deployment, but Atlas still runs the version from before (${short(r.version_id)}). Workers & Pages → your Atlas → Deployments shows what happened.`,
          ),
        });
      return;
    }
    // Something else deployed over what Atlas installed: Workers Builds after a push, or a deploy by hand.
    if (s.installed && r.version_id && r.version_id !== s.installed.version_id && s.foreign?.version_id !== r.version_id)
      saveUpdates(sql, { foreign: { version_id: r.version_id, seen_at: now, source: null, replaced: s.installed.label } });
  }

  // --- the daily look --------------------------------------------------------------------------------------

  /** The look on the clock. The item is leased; it's put back for tomorrow. */
  async look(item: AgendaItem | null): Promise<void> {
    try {
      await this.refresh();
    } finally {
      if (item) finish(this.d.sql, item.id, "done", null, {});
      await this.arm();
    }
  }

  /** Fetches the releases and the newest one's release.json; with a token, checks the newest against what Cloudflare runs. */
  async refresh(): Promise<void> {
    const sql = this.d.sql;
    const f = this.d.fetch();
    try {
      const releases = await fetchReleases(f);
      const newest = releases[0];
      if (newest)
        try {
          newest.manifest = (await fetchManifest(f, newest)).manifest;
        } catch (err) {
          newest.manifest_error = errText(err);
        }
      saveUpdates(sql, { releases, looked_at: Date.now(), look_error: null });
    } catch (err) {
      const error = errText(err);
      saveUpdates(sql, { looked_at: Date.now(), look_error: error });
      console.error(JSON.stringify({ at: "updates.look", error }));
    }
    this.settle();
    await this.#check();
    this.d.changed();
  }

  /** With a token: whether the newest release can go in as a version, and who made a version Atlas didn't install. */
  async #check(): Promise<void> {
    const sql = this.d.sql;
    const token = getSecret<string>(sql, "cf_update_token");
    const s = updatesState(sql);
    if (!token || !s.target) return;
    const f = this.d.fetch();
    const newest = s.releases[0];
    if (newest?.manifest && isNewer(newest, this.running()))
      try {
        const why = blockers(newest.manifest, await current(f, token, s.target), s.target.script);
        saveUpdates(sql, { blocked: why ? { tag: newest.tag, text: why } : null });
      } catch (err) {
        console.error(JSON.stringify({ at: "updates.check", error: errText(err) }));
      }
    if (s.foreign && !s.foreign.source)
      try {
        const v = await versionDetail(f, token, s.target, s.foreign.version_id);
        saveUpdates(sql, { foreign: { ...s.foreign, source: v.metadata?.source ?? "unknown" } });
      } catch (err) {
        console.error(JSON.stringify({ at: "updates.foreign", error: errText(err) }));
      }
  }

  // --- the token -------------------------------------------------------------------------------------------

  /** Keeps a token only once it finds this Atlas's Worker; null forgets it. */
  async token(token: string | null): Promise<{ ok: boolean; text: string }> {
    const sql = this.d.sql;
    if (!token) {
      setSecret(sql, "cf_update_token", null);
      saveUpdates(sql, { target: null, blocked: null });
      append(sql, { actor: "owner", kind: "settings.change", body: { updates: "token forgotten" } });
      return { ok: true, text: "Atlas forgot the updates token. Delete it on Cloudflare too (My Profile → API Tokens)." };
    }
    let hint: string | null = null;
    try {
      const h = new URL(this.d.origin() ?? "").hostname;
      if (h.endsWith(".workers.dev")) hint = h.split(".")[0] ?? null;
    } catch {
      hint = null;
    }
    try {
      const target = await findTarget(this.d.fetch(), token.trim(), this.running(), hint);
      setSecret(sql, "cf_update_token", token.trim());
      saveUpdates(sql, { target });
      append(sql, { actor: "owner", kind: "settings.change", body: { updates: "token set", script: target.script } });
      await this.#check();
      return { ok: true, text: `Updates go to your Worker "${target.script}". Atlas can install a release from here now.` };
    } catch (err) {
      return { ok: false, text: `Not kept: ${errText(err)}` };
    }
  }

  // --- update and roll back --------------------------------------------------------------------------------

  #ready(): { token: string; target: NonNullable<ReturnType<typeof updatesState>["target"]> } | string {
    if (this.#busy) return "An update or rollback is already running.";
    const token = getSecret<string>(this.d.sql, "cf_update_token");
    const target = updatesState(this.d.sql).target;
    if (!token || !target) return "Updates need a Cloudflare token first: make it with the link on this card, then paste it.";
    return { token, target };
  }

  /**
   * Installs a release: checks it can go in as a version, downloads the
   * bundle and checks every file's SHA-256, uploads the app's files, uploads
   * the Worker as a new version with the bindings restated and the secrets
   * kept, then deploys it to all traffic. Each step's outcome is kept in
   * Cloudflare's words; nothing is deployed unless every step before worked.
   */
  async install(tag: string): Promise<{ ok: boolean; text: string }> {
    const sql = this.d.sql;
    const ready = this.#ready();
    if (typeof ready === "string") return { ok: false, text: ready };
    const { token, target: t } = ready;
    const before = updatesState(sql);
    const release = before.releases.find((r) => r.tag === tag);
    if (!release) return { ok: false, text: `${tag} isn't among the releases Atlas knows. Look again first.` };
    this.#busy = true;
    const f = this.d.fetch();
    const r = this.running();
    let run: UpdateRun = {
      kind: "update",
      label: tag,
      from_version: r.version_id,
      to_version: null,
      state: "running",
      started_at: Date.now(),
      ended_at: null,
      steps: [],
    };
    const step = (what: Step["what"], ok: boolean, text: string) => {
      run = { ...run, steps: [...run.steps, { what, ok, text, at: Date.now() }] };
      saveUpdates(sql, { last: run });
      this.d.changed();
    };
    saveUpdates(sql, { last: run });
    this.d.changed();
    let what: Step["what"] = "check";
    try {
      const { manifest, bytes } = await fetchManifest(f, release);
      const now = await current(f, token, t);
      const why = blockers(manifest, now, t.script);
      saveUpdates(sql, { blocked: why ? { tag, text: why } : null });
      if (why) throw new Error(why);
      step("check", true, `${tag} can go in as a new version: the same Durable Objects, and storage changes that only add.`);

      what = "bundle";
      if (!release.bundle_url) throw new Error(`${tag} has no ${BUNDLE_ASSET} attached, so there's nothing to install.`);
      const gz = await fetchBytes(f, release.bundle_url, MAX_BUNDLE_BYTES);
      const files = await openBundle(gz, manifest, bytes);
      step(
        "bundle",
        true,
        `Downloaded the bundle (${mb(gz.length)}) and checked its ${Object.keys(manifest.files).length} files against release.json.`,
      );

      what = "assets";
      const a = await uploadAssets(f, token, t, files);
      step(
        "assets",
        true,
        a.uploaded
          ? `Cloudflare took the app's ${a.total} files (${a.uploaded} new).`
          : `Cloudflare already had all ${a.total} of the app's files.`,
      );

      what = "version";
      const v = await uploadVersion(f, token, t, { manifest, files, assets_jwt: a.jwt, had: now.version });
      run = { ...run, to_version: v.id };
      step(
        "version",
        true,
        `Cloudflare made version ${v.number ? `${v.number} ` : ""}(${short(v.id)}), with the bindings restated and the secrets kept.`,
      );

      what = "deploy";
      // Saved first: the deployment restarts Atlas, maybe before Cloudflare's answer gets back.
      run = { ...run, state: "deploying" };
      saveUpdates(sql, {
        last: run,
        previous: { version_id: now.version_id, label: r.version !== "unknown" ? r.version : `version ${short(now.version_id)}` },
      });
      await deploy(f, token, t, v.id, `Atlas ${tag}, from Atlas settings → Account → Updates`);
      append(sql, { actor: "owner", kind: "settings.change", body: { update: tag, version: v.id } });
      if (r.version_id) {
        step("deploy", true, `Cloudflare sends all traffic to ${tag} now. Atlas restarts on it in a moment.`);
      } else {
        run = { ...run, state: "done", ended_at: Date.now() };
        step("deploy", true, `Cloudflare sends all traffic to ${tag} now.`);
        saveUpdates(sql, { installed: { version_id: v.id, label: tag, at: Date.now() }, foreign: null });
      }
      return { ok: true, text: `Installing ${tag}. Atlas restarts on it in a moment.` };
    } catch (err) {
      const text = errText(err);
      run = { ...run, state: "failed", ended_at: Date.now() };
      if (what === "deploy") saveUpdates(sql, { previous: before.previous });
      step(what, false, text);
      console.error(JSON.stringify({ at: "updates.install", step: what, tag, error: text }));
      return { ok: false, text };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Puts the version before the last update back, at 100%. Cloudflare refuses
   * a version from before a secret changed unless it's forced; then the card
   * offers Roll back anyway. The data isn't touched: it only grows.
   */
  async rollback(force = false): Promise<{ ok: boolean; text: string }> {
    const sql = this.d.sql;
    const ready = this.#ready();
    if (typeof ready === "string") return { ok: false, text: ready };
    const { token, target: t } = ready;
    const to = updatesState(sql).previous;
    if (!to) return { ok: false, text: "There's no version from before an update to go back to." };
    this.#busy = true;
    const r = this.running();
    let run: UpdateRun = {
      kind: "rollback",
      label: to.label,
      from_version: r.version_id,
      to_version: to.version_id,
      state: "deploying",
      started_at: Date.now(),
      ended_at: null,
      steps: [],
    };
    saveUpdates(sql, { last: run });
    this.d.changed();
    try {
      await deploy(this.d.fetch(), token, t, to.version_id, `Rolled back to ${to.label} from Atlas settings → Account → Updates`, force);
      run = {
        ...run,
        state: "done",
        ended_at: Date.now(),
        steps: [
          {
            what: "deploy",
            ok: true,
            text: `Cloudflare sends all traffic to ${to.label} again${force ? ", with the secrets it had then" : ""}. Your data stays as it is.`,
            at: Date.now(),
          },
        ],
      };
      saveUpdates(sql, {
        last: run,
        previous: null,
        installed: { version_id: to.version_id, label: to.label, at: Date.now() },
        foreign: null,
      });
      append(sql, { actor: "owner", kind: "settings.change", body: { rollback: to.label, version: to.version_id, force } });
      return { ok: true, text: `Rolling back to ${to.label}. Atlas restarts on it in a moment.` };
    } catch (err) {
      const needs = err instanceof CloudflareError && err.codes.includes(SECRET_CHANGED);
      const text = `${errText(err)}${needs ? " Roll back anyway puts that version back with the secrets it had then." : ""}`;
      run = {
        ...run,
        state: "failed",
        ended_at: Date.now(),
        needs_force: needs,
        steps: [{ what: "deploy", ok: false, text, at: Date.now() }],
      };
      saveUpdates(sql, { last: run });
      console.error(JSON.stringify({ at: "updates.rollback", force, error: errText(err) }));
      return { ok: false, text };
    } finally {
      this.#busy = false;
      this.d.changed();
    }
  }

  // --- the card --------------------------------------------------------------------------------------------

  view(): UpdatesView {
    const s = updatesState(this.d.sql);
    const r = this.running();
    const newest = s.releases[0] ?? null;
    return {
      running: { version: r.version, commit: r.commit, version_id: r.version_id },
      token: Boolean(getSecret(this.d.sql, "cf_update_token")),
      token_link: updateTokenLink(),
      script: s.target?.script ?? null,
      looked_at: s.looked_at,
      look_error: s.look_error,
      newest: newest
        ? {
            tag: newest.tag,
            name: newest.name,
            notes: newest.notes,
            published_at: newest.published_at,
            url: newest.url,
            problem: newest.manifest_error ?? (s.blocked?.tag === newest.tag ? s.blocked.text : null),
          }
        : null,
      ready: Boolean(newest && isNewer(newest, r)),
      run: s.last,
      rollback: s.previous ? { label: s.previous.label } : null,
      foreign: s.foreign
        ? {
            at: s.foreign.seen_at,
            text: `A version Atlas didn't install is running (${short(s.foreign.version_id)}, made by ${sourceWords(s.foreign.source)}). It replaced ${s.foreign.replaced}.${
              s.foreign.source === "workersci" || !s.foreign.source
                ? " To keep installing from here, disconnect the repository: Workers & Pages → your Atlas → Settings → Build → Disconnect."
                : ""
            }`,
          }
        : null,
      busy: this.#busy,
    };
  }
}
