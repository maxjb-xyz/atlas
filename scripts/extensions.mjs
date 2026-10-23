// Builds the bundled extensions (VISION §17): each extensions/<name>/index.ts
// becomes one ES module, kept as text in core/src/extensions.gen.ts with its
// manifest and the calls it takes, for the core to load into a sandbox.
// Readable on purpose: the owner can see what each one does before installing it.

import { build } from "esbuild";
import { readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

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
    if (ext.manifest.id !== name) throw new Error(`extensions/${name}'s manifest id is "${ext.manifest.id}"; it must be its folder's name.`);
    const methods = Object.keys(ext).filter((k) => typeof ext[k] === "function").sort();
    out[name] = { manifest: ext.manifest, methods, code };
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
