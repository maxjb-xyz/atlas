// A release's bundle (VISION §23.2): what a deployed Atlas needs to update
// itself, built by .github/workflows/release.yml when a release is published.
// It holds the Worker as Wrangler bundles it, the app's files, and
// release.json: the version, the commit, how many storage changes it has
// (an update can't go to a release with fewer than the deployment has run),
// its Durable Object classes and bindings (a change there needs a full
// deploy, not an update), what a version upload through Cloudflare's API
// needs (`worker`), and each file's SHA-256. A deployed Atlas checks every
// file against these before it uploads anything (core/src/updates.ts).
//
//   node scripts/release.mjs <version> <out-dir>

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { build } from "esbuild";

const [version, out = "release"] = process.argv.slice(2);
if (!version) throw new Error("Say the version: node scripts/release.mjs v1.0.0 release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The Worker, bundled as a deploy would, without deploying.
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(out, "worker")], { stdio: "inherit" });
// The app, as the Worker serves it.
cpSync("app/dist", join(out, "assets"), { recursive: true });

// How many storage changes this release has, from the code itself.
const db = await build({ entryPoints: ["core/src/store/db.ts"], bundle: true, format: "esm", platform: "node", write: false });
const mod = await import(`data:text/javascript;base64,${Buffer.from(db.outputFiles[0].text).toString("base64")}`);

const config = JSON.parse(
  readFileSync("wrangler.jsonc", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1"),
);

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(out, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
};
walk(out);

const manifest = {
  atlas_release: 1,
  version,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  built_at: new Date().toISOString(),
  schema: mod.MIGRATIONS.length,
  only_adds_from: mod.ONLY_ADDS_FROM,
  classes: (config.durable_objects?.bindings ?? []).map((b) => b.class_name).sort(),
  bindings: {
    ai: Boolean(config.ai),
    browser: Boolean(config.browser),
    worker_loaders: (config.worker_loaders ?? []).map((b) => b.binding),
    r2: (config.r2_buckets ?? []).map((b) => b.binding),
    containers: (config.containers ?? []).map((c) => c.class_name),
  },
  compatibility_date: config.compatibility_date,
  // What a version upload through Cloudflare's API needs beyond the files (core/src/updates.ts): the main module,
  // the flags, the Durable Object migrations' tags (a new one needs a full deploy), the containers, the assets'
  // routing and every binding in the shape Cloudflare's upload metadata takes.
  worker: {
    main_module: `${basename(config.main).replace(/\.[cm]?[jt]s$/, "")}.js`,
    compatibility_flags: config.compatibility_flags ?? [],
    migrations: (config.migrations ?? []).map((m) => m.tag),
    containers: (config.containers ?? []).map((c) => ({ class_name: c.class_name })),
    assets: {
      binding: config.assets?.binding ?? "ASSETS",
      config: Object.fromEntries(
        Object.entries({
          html_handling: config.assets?.html_handling,
          not_found_handling: config.assets?.not_found_handling,
          run_worker_first: config.assets?.run_worker_first,
        }).filter(([, v]) => v !== undefined),
      ),
    },
    bindings: [
      ...(config.ai ? [{ type: "ai", name: config.ai.binding }] : []),
      ...(config.browser ? [{ type: "browser", name: config.browser.binding }] : []),
      ...(config.version_metadata ? [{ type: "version_metadata", name: config.version_metadata.binding }] : []),
      ...(config.worker_loaders ?? []).map((b) => ({ type: "worker_loader", name: b.binding })),
      ...(config.r2_buckets ?? []).map((b) => ({ type: "r2_bucket", name: b.binding, bucket_name: b.bucket_name })),
      ...(config.durable_objects?.bindings ?? []).map((b) => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name })),
      ...(config.assets?.binding ? [{ type: "assets", name: config.assets.binding }] : []),
      ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ type: "plain_text", name, text: String(text) })),
    ],
  },
  files,
};
if (!files[`worker/${manifest.worker.main_module}`]) throw new Error(`The dry run made no worker/${manifest.worker.main_module}.`);
writeFileSync(join(out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Release ${version}: schema ${manifest.schema}, ${Object.keys(files).length} files, in ${out}/`);
