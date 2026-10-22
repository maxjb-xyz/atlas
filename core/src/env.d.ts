// Bindings, as configured in wrangler.jsonc. Secrets are set with
// `wrangler secret put`; ATLAS_TEST is only set by the test runner.
interface Env {
  AI: Ai;
  BROWSER: BrowserRun;
  ASSETS: Fetcher;
  PersonAgent: DurableObjectNamespace<import("./index").PersonAgent>;
  ATLAS_OWNER_SECRET?: string;
  ATLAS_TEST?: string;
}
