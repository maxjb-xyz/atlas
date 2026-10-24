// Updates (VISION §23.2): the daily look finds a newer release on GitHub;
// Update checks the bundle's SHA-256s, then makes an assets upload session,
// a version with the bindings restated and the secrets kept, and a
// deployment of it at 100%, in that order, through Cloudflare's API; Roll
// back deploys the version before, with `force` once Cloudflare says a
// secret changed; and a release that changes the Durable Objects is refused
// before anything is uploaded, with what to do instead. All against fakes.

import { beforeEach, describe, expect, it } from "vitest";
import { UpdateDesk } from "../src/agent/updates";
import { sha256Hex } from "../src/services";
import { upcoming } from "../src/store/agenda";
import type { Sql } from "../src/store/db";
import { getSecret, setSecret } from "../src/store/settings";
import { setState } from "../src/store/state";
import { isNewer, type ReleaseManifest, type Running, untar, updatesState, updateTokenLink } from "../src/updates";
import { connect, inOwner } from "./owner";

const enc = (t: string) => new TextEncoder().encode(t);

/** A tar archive as `tar -czf … -C release .` makes it, before gzip. */
function tar(files: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, body] of Object.entries(files)) {
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(enc(s), off);
    put(`./${name}`, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    h[156] = "0".charCodeAt(0);
    put("ustar\0", 257);
    put("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const FILES: Record<string, string> = {
  "worker/index.js": "export default { fetch() { return new Response('v0.8.0'); } };",
  "worker/index.js.map": "{}",
  "worker/README.md": "Made by wrangler.",
  "assets/index.html": "<!doctype html><title>Atlas</title>",
  "assets/assets/app-abc.js": "console.log('app')",
  "assets/version.json": '{"version":"v0.8.0"}',
};

async function release(o: { tag?: string; tamper?: string; manifest?: (m: ReleaseManifest) => void } = {}) {
  const tag = o.tag ?? "v0.8.0";
  const files: Record<string, string> = {};
  for (const [p, t] of Object.entries(FILES)) files[p] = await sha256Hex(enc(t));
  const manifest: ReleaseManifest = {
    atlas_release: 1,
    version: tag,
    commit: "b".repeat(40),
    schema: 999,
    classes: ["PersonAgent", "Workspace"],
    compatibility_date: "2026-10-01",
    worker: {
      main_module: "index.js",
      compatibility_flags: ["nodejs_compat"],
      migrations: ["v1", "v2"],
      containers: [{ class_name: "Workspace" }],
      assets: { binding: "ASSETS", config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] } },
      bindings: [
        { type: "ai", name: "AI" },
        { type: "version_metadata", name: "CF_VERSION_METADATA" },
        { type: "r2_bucket", name: "FILES", bucket_name: "atlas-files" },
        { type: "durable_object_namespace", name: "PersonAgent", class_name: "PersonAgent" },
        { type: "durable_object_namespace", name: "WORKSPACE", class_name: "Workspace" },
        { type: "assets", name: "ASSETS" },
      ],
    },
    files,
  };
  o.manifest?.(manifest);
  const manifestBytes = enc(JSON.stringify(manifest, null, 2));
  const inside: Record<string, Uint8Array> = {};
  for (const [p, t] of Object.entries(FILES)) inside[p] = enc(p === o.tamper ? `${t} // changed` : t);
  inside["release.json"] = manifestBytes;
  return { tag, manifest: manifestBytes, bundle: await gzip(tar(inside)) };
}

interface Call {
  method: string;
  url: URL;
  auth: string | null;
  body: unknown;
  form: Record<string, { text: string; type: string }> | null;
}

/** GitHub's releases and a Cloudflare account with one Atlas Worker in it, recording each call. */
function fakes(r: Awaited<ReturnType<typeof release>>, opts: { secretChanged?: boolean; githubStatus?: number } = {}) {
  const calls: Call[] = [];
  const cf = {
    running: "ver-old",
    versions: {
      "ver-old": {
        id: "ver-old",
        number: 7,
        metadata: { source: "wrangler" },
        resources: {
          bindings: [
            { type: "ai", name: "AI" },
            { type: "browser", name: "BROWSER" },
            { type: "r2_bucket", name: "FILES", bucket_name: "atlas-files" },
            { type: "durable_object_namespace", name: "PersonAgent", class_name: "PersonAgent", namespace_id: "ns1" },
            { type: "durable_object_namespace", name: "WORKSPACE", class_name: "Workspace", namespace_id: "ns2" },
            { type: "assets", name: "ASSETS" },
            { type: "secret_text", name: "ATLAS_OWNER_SECRET" },
            { type: "secret_text", name: "ATLAS_DATA_KEY" },
          ],
          script_runtime: { migration_tag: "v2" },
        },
      },
    } as Record<string, unknown>,
    refuseRollback: opts.secretChanged ?? false,
  };
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    let form: Call["form"] = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries())
        form[k] = typeof v === "string" ? { text: v, type: "" } : { text: await (v as Blob).text(), type: (v as Blob).type };
    }
    calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body, form });
    if (url.hostname === "api.github.com") {
      if (opts.githubStatus) return Response.json({ message: "API rate limit exceeded for 1.2.3.4." }, { status: opts.githubStatus });
      return Response.json([
        { tag_name: "v0.9.0-rc.1", name: "Next", prerelease: true, published_at: "2026-10-24T12:00:00Z", assets: [] },
        {
          tag_name: r.tag,
          name: `Atlas ${r.tag}`,
          body: "Updates from the app.",
          published_at: "2026-10-24T09:00:00Z",
          html_url: `https://github.com/maxjb-xyz/atlas/releases/tag/${r.tag}`,
          assets: [
            { name: "release.json", browser_download_url: `https://github.com/maxjb-xyz/atlas/releases/download/${r.tag}/release.json` },
            {
              name: "atlas-release.tar.gz",
              browser_download_url: `https://github.com/maxjb-xyz/atlas/releases/download/${r.tag}/atlas-release.tar.gz`,
            },
          ],
        },
        { tag_name: "v0.7.0", name: "Atlas v0.7.0", published_at: "2026-10-01T09:00:00Z", assets: [] },
      ]);
    }
    if (url.hostname === "github.com") {
      if (url.pathname.endsWith("/release.json")) return new Response(r.manifest);
      if (url.pathname.endsWith("/atlas-release.tar.gz")) return new Response(r.bundle);
      return new Response("Not Found", { status: 404 });
    }
    if (url.hostname !== "api.cloudflare.com") return new Response("unexpected host", { status: 599 });
    const path = url.pathname.replace("/client/v4", "");
    const auth = new Headers(init?.headers).get("authorization");
    if (path === "/accounts/acc1/workers/assets/upload") {
      if (auth !== "Bearer session-jwt")
        return Response.json({ success: false, errors: [{ code: 10001, message: "bad jwt" }] }, { status: 401 });
      return ok({ jwt: "completion-jwt" }, 201);
    }
    if (auth !== "Bearer cf-token-123")
      return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    if (path === "/accounts") return ok([{ id: "acc1", name: "Owner's account" }]);
    if (path === "/accounts/acc1/workers/scripts") return ok([{ id: "mail-relay" }, { id: "atlas", migration_tag: "v2" }]);
    if (path === "/accounts/acc1/workers/scripts/mail-relay/deployments")
      return ok({ deployments: [{ id: "d0", versions: [{ version_id: "relay-1", percentage: 100 }] }] });
    if (path === "/accounts/acc1/workers/scripts/atlas/deployments" && method === "GET")
      return ok({ deployments: [{ id: "d1", source: "wrangler", versions: [{ version_id: cf.running, percentage: 100 }] }] });
    const v = /^\/accounts\/acc1\/workers\/scripts\/atlas\/versions\/(.+)$/.exec(path);
    if (v && method === "GET") return cf.versions[v[1]!] ? ok(cf.versions[v[1]!]) : new Response("{}", { status: 404 });
    if (path === "/accounts/acc1/workers/scripts/atlas/assets-upload-session") {
      const manifest = (body as { manifest: Record<string, { hash: string }> }).manifest;
      return ok({ jwt: "session-jwt", buckets: [Object.values(manifest).map((m) => m.hash)] });
    }
    if (path === "/accounts/acc1/workers/scripts/atlas/versions" && method === "POST") {
      cf.versions["ver-new"] = { ...(cf.versions["ver-old"] as object), id: "ver-new", number: 8, metadata: { source: "api" } };
      return ok({ id: "ver-new", number: 8 });
    }
    if (path === "/accounts/acc1/workers/scripts/atlas/deployments" && method === "POST") {
      const to = (body as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
      if (cf.refuseRollback && to === "ver-old" && url.searchParams.get("force") !== "true")
        return Response.json(
          {
            success: false,
            errors: [{ code: 10220, message: "The following secrets have changed: ATLAS_DATA_KEY" }],
          },
          { status: 400 },
        );
      cf.running = to;
      return ok({ id: "d2", source: "api", versions: [{ version_id: to, percentage: 100 }] });
    }
    return new Response(`no fake for ${method} ${path}`, { status: 599 });
  }) as typeof fetch;
  return { f, calls, cf };
}

const clock = { schedule: async () => {}, unschedule: async () => {} };
const running = (o: Partial<Running> = {}): Running => ({ version: "v0.7.0", commit: "a".repeat(40), version_id: "ver-old", ...o });

function desk(sql: Sql, f: typeof fetch, r: Running = running()) {
  const d = new UpdateDesk({
    sql,
    fetch: () => f,
    clock,
    running: async () => r,
    origin: () => "https://atlas.owner.workers.dev",
    changed: () => {},
  });
  return d;
}

const cfCalls = (calls: Call[]) => calls.filter((c) => c.url.hostname === "api.cloudflare.com" && c.method === "POST");

beforeEach(async () => {
  await inOwner((_a, sql) => {
    setState(sql, "updates", null);
    setSecret(sql, "cf_update_token", null);
  });
});

describe("the daily look", () => {
  it("is on the clock once a day", async () => {
    await connect();
    expect(await inOwner((_a, sql) => upcoming(sql, 300).filter((i) => i.kind === "updates").length)).toBe(1);
  });

  it("finds a newer release, with its notes, and leaves out pre-releases", async () => {
    const r = await release();
    const { f } = fakes(r);
    const v = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      await d.refresh();
      return d.view();
    });
    expect(v.newest).toMatchObject({ tag: "v0.8.0", name: "Atlas v0.8.0", notes: "Updates from the app.", problem: null });
    expect(v.ready).toBe(true);
    expect(v.running.version).toBe("v0.7.0");
    expect(v.token).toBe(false);
    expect(v.token_link).toContain("dash.cloudflare.com/profile/api-tokens");
  });

  it("isn't ready when this Atlas is that release, or past it", async () => {
    const r = await release();
    const { f } = fakes(r);
    const v = await inOwner(async (_a, sql) => {
      const d = desk(sql, f, running({ version: "v0.8.0-3-g1234abc" }));
      await d.start();
      await d.refresh();
      return d.view();
    });
    expect(v.ready).toBe(false);
  });

  it("keeps GitHub's own words when the look fails", async () => {
    const r = await release();
    const { f } = fakes(r, { githubStatus: 403 });
    const v = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.refresh();
      return d.view();
    });
    expect(v.look_error).toBe("api.github.com answered 403: API rate limit exceeded for 1.2.3.4.");
  });
});

describe("versions", () => {
  it("compares tags, describe output and commits", () => {
    const rel = (tag: string, commit = "c".repeat(40)) => ({ tag, manifest: { commit } as ReleaseManifest });
    expect(isNewer(rel("v0.8.0"), running())).toBe(true);
    expect(isNewer(rel("v0.7.0"), running())).toBe(false);
    expect(isNewer(rel("v0.7.1"), running({ version: "v0.7.0-12-gabcdef0" }))).toBe(true);
    expect(isNewer(rel("v0.7.0"), running({ version: "v0.7.0-12-gabcdef0" }))).toBe(false);
    expect(isNewer(rel("v1.0.0"), running({ version: "v1.0.0-rc.2" }))).toBe(true);
    // Not from a release: any release is offered, unless it's this very commit.
    expect(isNewer(rel("v0.1.0"), running({ version: "d229642", commit: "d229642" }))).toBe(true);
    expect(isNewer(rel("v0.1.0", "d229642aaaa"), running({ version: "d229642", commit: "d229642" }))).toBe(false);
  });

  it("makes the token on Cloudflare's own page, with Workers Scripts · Edit", () => {
    const u = new URL(updateTokenLink());
    expect(u.origin + u.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(JSON.parse(u.searchParams.get("permissionGroupKeys")!)).toEqual([{ key: "workers_scripts", type: "edit" }]);
    expect(u.searchParams.get("name")).toBe("Atlas updates");
    expect(u.searchParams.get("accountId")).toBe("*");
  });

  it("reads a tar archive's files without the leading ./", async () => {
    const t = untar(tar({ "worker/index.js": enc("x"), "assets/a/b.css": enc("body{}") }));
    expect([...t.keys()]).toEqual(["worker/index.js", "assets/a/b.css"]);
    expect(new TextDecoder().decode(t.get("assets/a/b.css"))).toBe("body{}");
  });
});

describe("the token", () => {
  it("finds this Atlas's Worker by the version it runs, and keeps a token only when it does", async () => {
    const r = await release();
    const { f } = fakes(r);
    const out = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      const bad = await d.token("wrong-token-0000");
      const kept1 = getSecret(sql, "cf_update_token");
      const good = await d.token("cf-token-123");
      return { bad, kept1, good, target: updatesState(sql).target, view: d.view() };
    });
    expect(out.bad.ok).toBe(false);
    expect(out.bad.text).toContain("Cloudflare said: Authentication error (10000) (HTTP 403, GET /accounts)");
    expect(out.kept1).toBeNull();
    expect(out.good).toEqual({ ok: true, text: 'Updates go to your Worker "atlas". Atlas can install a release from here now.' });
    expect(out.target).toEqual({ account_id: "acc1", script: "atlas" });
    expect(out.view.script).toBe("atlas");
  });
});

describe("update and roll back", () => {
  async function ready(r: Awaited<ReturnType<typeof release>>, o: Parameters<typeof fakes>[1] = {}) {
    const fk = fakes(r, o);
    await inOwner(async (_a, sql) => {
      const d = desk(sql, fk.f);
      await d.start();
      await d.refresh();
      expect((await d.token("cf-token-123")).ok).toBe(true);
    });
    fk.calls.length = 0;
    return fk;
  }

  it("uploads the app's files, then a version, then deploys it at 100%, in that order and with the right bodies", async () => {
    const r = await release();
    const { f, calls } = await ready(r);
    const out = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      return { res: await d.install("v0.8.0"), view: d.view() };
    });
    expect(out.res).toEqual({ ok: true, text: "Installing v0.8.0. Atlas restarts on it in a moment." });
    const posts = cfCalls(calls);
    expect(posts.map((c) => c.url.pathname.replace("/client/v4/accounts/acc1/workers", ""))).toEqual([
      "/scripts/atlas/assets-upload-session",
      "/assets/upload",
      "/scripts/atlas/versions",
      "/scripts/atlas/deployments",
    ]);
    // The session lists every file of the app by its path, a 32-character hash and its size.
    const manifest = (posts[0]!.body as { manifest: Record<string, { hash: string; size: number }> }).manifest;
    expect(Object.keys(manifest).sort()).toEqual(["/assets/app-abc.js", "/index.html", "/version.json"]);
    expect(manifest["/index.html"]).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{32}$/), size: FILES["assets/index.html"]!.length });
    // The files go up base64'd, named by their hash, with the session's token.
    const up = posts[1]!;
    expect(up.url.searchParams.get("base64")).toBe("true");
    expect(up.auth).toBe("Bearer session-jwt");
    const html = up.form![manifest["/index.html"]!.hash]!;
    expect(atob(html.text)).toBe(FILES["assets/index.html"]);
    expect(html.type).toBe("text/html");
    // The version: the main module only, the bindings restated by name, the secrets kept, the assets' completion token.
    const ver = posts[2]!;
    expect(ver.url.searchParams.get("bindings_inherit")).toBe("strict");
    expect(Object.keys(ver.form!).sort()).toEqual(["index.js", "metadata"]);
    expect(ver.form!["index.js"]!.type).toBe("application/javascript+module");
    const meta = JSON.parse(ver.form!.metadata!.text) as Record<string, unknown>;
    expect(meta).toMatchObject({
      main_module: "index.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      keep_bindings: ["secret_text", "secret_key"],
      containers: [{ class_name: "Workspace" }],
      assets: { jwt: "completion-jwt", config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] } },
      annotations: { "workers/tag": "v0.8.0" },
    });
    expect(meta.bindings).toEqual([
      { type: "inherit", name: "AI" },
      { type: "inherit", name: "BROWSER" },
      { type: "inherit", name: "FILES" },
      { type: "inherit", name: "PersonAgent" },
      { type: "inherit", name: "WORKSPACE" },
      { type: "assets", name: "ASSETS" },
      { type: "version_metadata", name: "CF_VERSION_METADATA" },
    ]);
    expect(JSON.stringify(meta)).not.toContain("ATLAS_DATA_KEY");
    // Then all traffic to it.
    expect(posts[3]!.body).toMatchObject({ strategy: "percentage", versions: [{ version_id: "ver-new", percentage: 100 }] });
    expect(out.view.run?.state).toBe("deploying");
    expect(out.view.run?.steps.map((s) => [s.what, s.ok])).toEqual([
      ["check", true],
      ["bundle", true],
      ["assets", true],
      ["version", true],
      ["deploy", true],
    ]);
    expect(out.view.run?.steps[3]!.text).toContain("Cloudflare made version 8 (ver-new)");

    // Atlas restarts on the new version: the update is settled as done, and Roll back goes to the one before.
    const after = await inOwner(async (_a, sql) => {
      const d = desk(sql, f, running({ version: "v0.8.0", version_id: "ver-new" }));
      await d.start();
      return d.view();
    });
    expect(after.run?.state).toBe("done");
    expect(after.run?.steps.at(-1)?.text).toBe("Atlas is running v0.8.0 now (version ver-new).");
    expect(after.rollback).toEqual({ label: "v0.7.0" });
    expect(after.ready).toBe(false);
  });

  it("refuses a bundle whose hash doesn't match, before anything reaches Cloudflare", async () => {
    const r = await release({ tamper: "worker/index.js" });
    const { f, calls } = await ready(r);
    const out = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      return { res: await d.install("v0.8.0"), view: d.view() };
    });
    expect(out.res.ok).toBe(false);
    expect(out.res.text).toMatch(
      /^worker\/index\.js in the bundle doesn't match release\.json's SHA-256 \(expected [0-9a-f]{12}…, got [0-9a-f]{12}…\), so nothing was uploaded\.$/,
    );
    expect(cfCalls(calls)).toEqual([]);
    expect(out.view.run?.state).toBe("failed");
    expect(out.view.run?.steps.at(-1)).toMatchObject({ what: "bundle", ok: false });
    expect(out.view.rollback).toBeNull();
  });

  it("rolls back to the version before, with force once Cloudflare says a secret changed", async () => {
    const r = await release();
    const { f, calls } = await ready(r, { secretChanged: true });
    await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      expect((await d.install("v0.8.0")).ok).toBe(true);
    });
    calls.length = 0;
    const out = await inOwner(async (_a, sql) => {
      const d = desk(sql, f, running({ version: "v0.8.0", version_id: "ver-new" }));
      await d.start();
      const refused = await d.rollback();
      const refusedView = d.view();
      const forced = await d.rollback(true);
      return { refused, refusedView, forced, view: d.view() };
    });
    expect(out.refused.ok).toBe(false);
    expect(out.refused.text).toContain("Cloudflare said: The following secrets have changed: ATLAS_DATA_KEY (10220) (HTTP 400");
    expect(out.refusedView.run?.needs_force).toBe(true);
    expect(out.refusedView.rollback).toEqual({ label: "v0.7.0" });
    expect(out.forced.ok).toBe(true);
    const posts = cfCalls(calls);
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.body).toMatchObject({ strategy: "percentage", versions: [{ version_id: "ver-old", percentage: 100 }] });
    expect(posts[0]!.url.searchParams.get("force")).toBeNull();
    expect(posts[1]!.url.searchParams.get("force")).toBe("true");
    expect(out.view.run).toMatchObject({ kind: "rollback", state: "done" });
    expect(out.view.rollback).toBeNull();
    // Back on the old version, the release is offered again.
    const back = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      return d.view();
    });
    expect(back.ready).toBe(true);
    expect(back.foreign).toBeNull();
  });

  it("refuses a release that changes the Durable Objects, saying so before updating and what to do", async () => {
    const r = await release({
      manifest: (m) => {
        m.classes.push("Notebook");
        m.worker!.migrations.push("v3");
      },
    });
    const { f, calls } = await ready(r);
    const out = await inOwner(async (_a, sql) => {
      const d = desk(sql, f);
      await d.start();
      const before = d.view();
      return { before, res: await d.install("v0.8.0") };
    });
    // The look already said so, on the card.
    expect(out.before.newest?.problem).toContain("its Durable Object migration v3, after v2; a new Durable Object class, Notebook");
    expect(out.res.ok).toBe(false);
    expect(out.res.text).toContain("Cloudflare applies that only with a full deploy, and nothing rolls back past it.");
    expect(out.res.text).toContain("npm run deploy -- --name atlas");
    expect(cfCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.url.pathname.endsWith("atlas-release.tar.gz"))).toBe(false);
  });

  it("notices a version Atlas didn't install, and who made it", async () => {
    const r = await release();
    const fk = await ready(r);
    await inOwner(async (_a, sql) => {
      const d = desk(sql, fk.f);
      await d.start();
      await d.install("v0.8.0");
      await desk(sql, fk.f, running({ version: "v0.8.0", version_id: "ver-new" })).start();
    });
    fk.cf.versions["ver-ci"] = { id: "ver-ci", metadata: { source: "workersci" }, resources: { bindings: [] } };
    const v = await inOwner(async (_a, sql) => {
      const d = desk(sql, fk.f, running({ version: "e3b0c44", commit: "e3b0c44", version_id: "ver-ci" }));
      await d.start();
      await d.refresh();
      return d.view();
    });
    expect(v.foreign?.text).toContain("made by Workers Builds, after a push to your copy of the repository");
    expect(v.foreign?.text).toContain("It replaced v0.8.0.");
    expect(v.foreign?.text).toContain("Settings → Build → Disconnect");
  });
});
