import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// In dev, the Worker runs on wrangler's port; the app proxies to it.
const worker = "http://127.0.0.1:8787";

/** Which Atlas this is: the release's tag when built from one, else the commit, so the app never claims a milestone. */
function version(): string {
  if (process.env.ATLAS_VERSION) return process.env.ATLAS_VERSION;
  try {
    return execSync("git describe --tags --always", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

function commit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Which Atlas this is, for the Worker too (VISION §23.2): the Updates card compares it with the newest release. */
const versionFile: Plugin = {
  name: "atlas-version",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ version: version(), commit: commit() })}\n` });
  },
};

export default defineConfig({
  plugins: [react(), versionFile],
  define: { __ATLAS_VERSION__: JSON.stringify(version()) },
  server: {
    proxy: {
      "/api": { target: worker, changeOrigin: false },
      "/agents": { target: worker, changeOrigin: false, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
