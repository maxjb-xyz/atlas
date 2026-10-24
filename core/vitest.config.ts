import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: { ATLAS_OWNER_SECRET: "test-owner-secret-not-real", ATLAS_DATA_KEY: "test-data-key-not-real-0123456789abcdef", ATLAS_TEST: "1" },
        // Test-only: lets the test runtime host helpers as sub-agents. Production needs no binding.
        durableObjects: { HELPER_AGENT: { className: "HelperAgent", useSQLite: true } },
      },
    }),
  ],
});
