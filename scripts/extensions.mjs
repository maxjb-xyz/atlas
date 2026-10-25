// Builds the bundled extensions (VISION §17): each extensions/<name>/index.ts
// becomes one ES module, kept as text in core/src/extensions.gen.ts with its
// manifest and the calls it takes, for the core to load into a sandbox.
// Readable on purpose: the owner can see what each one does before installing it.
// An icon.svg or icon.png beside it becomes its manifest's icon.
//
// It also takes this release's snapshot of the services index
// (index/services.json) into core/src/services.gen.ts, so the catalog works
// when GitHub doesn't (§17). The core reads it with the same checks as an
// index it fetches; here it only checks what needs the repo to check.

import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "extensions");
const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory() && !n.startsWith(".") && n !== "lib");
const out = {};
const tmp = mkdtempSync(join(tmpdir(), "atlas-ext-"));
try {
  for (const name of names.sort()) {
    const res = await build({
      entryPoints: [join(dir, name, "index.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
      minify: false,
      legalComments: "none",
      logLevel: "error",
    });
    const code = res.outputFiles[0].text;
    const file = join(tmp, `${name}.mjs`);
    writeFileSync(file, code);
    const ext = (await import(pathToFileURL(file).href)).default;
    if (!ext?.manifest?.id) throw new Error(`extensions/${name} has no default export with a manifest.`);
    if (ext.manifest.id !== name)
      throw new Error(`extensions/${name}'s manifest id is "${ext.manifest.id}"; it must be its folder's name.`);
    const methods = Object.keys(ext)
      .filter((k) => typeof ext[k] === "function")
      .sort();
    const icon = iconOf(join(dir, name));
    const manifest = icon && !ext.manifest.icon ? { ...ext.manifest, icon } : ext.manifest;
    if ((manifest.tools ?? []).length && !methods.includes("tool"))
      throw new Error(`extensions/${name} declares tools but has no tool call.`);
    out[name] = { manifest, methods, code };
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const body = `// Made by scripts/extensions.mjs from extensions/: don't edit by hand. npm run extensions makes it again.

import type { Manifest } from "../../extensions/sdk";

export const BUNDLED: Record<string, { manifest: Manifest; methods: string[]; code: string }> = ${JSON.stringify(out, null, 2)};
`;
writeFileSync(join(root, "core/src/extensions.gen.ts"), body);
console.log(`Built ${names.length} extension${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);

// --- the index's snapshot ------------------------------------------------------------------------------------

const indexFile = join(root, "index/services.json");
const index = JSON.parse(readFileSync(indexFile, "utf8"));
const seen = new Set();
for (const s of index.services ?? []) {
  if (seen.has(s.id)) throw new Error(`index/services.json lists "${s.id}" twice.`);
  seen.add(s.id);
  const b = s.extension?.bundled;
  if (b && !out[b]) throw new Error(`index/services.json: "${s.id}" names the bundled extension "${b}", which isn't in extensions/.`);
}
for (const name of names) {
  if (!(index.services ?? []).some((s) => s.extension?.bundled === name))
    throw new Error(`extensions/${name} isn't in index/services.json: every bundled extension is a service in the catalog.`);
}
writeFileSync(
  join(root, "core/src/services.gen.ts"),
  `// Made by scripts/extensions.mjs from index/services.json: don't edit by hand. npm run extensions makes it again.

/** This release's snapshot of the services index (VISION §17), read by core/src/services.ts. */
export const SNAPSHOT: unknown = ${JSON.stringify(index, null, 2)};
`,
);
const hubs = (index.hubs ?? []).length;
console.log(`Took the index's snapshot: ${seen.size} services and ${hubs} skill ${hubs === 1 ? "hub" : "hubs"}`);

/** A folder's icon.svg or icon.png as a data URI. */
function iconOf(folder) {
  for (const [file, type] of [
    ["icon.svg", "image/svg+xml"],
    ["icon.png", "image/png"],
  ]) {
    const p = join(folder, file);
    if (existsSync(p)) return `data:${type};base64,${readFileSync(p).toString("base64")}`;
  }
  return null;
}
