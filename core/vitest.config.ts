import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: { ATLAS_OWNER_SECRET: "test-owner-secret-not-real", ATLAS_TEST: "1" },
      },
    }),
  ],
});
