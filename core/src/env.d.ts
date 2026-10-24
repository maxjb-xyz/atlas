// Bindings, as configured in the repo root's wrangler.jsonc. Secrets are set with
// `wrangler secret put`; ATLAS_TEST is only set by the test runner.
interface Env {
  AI: Ai;
  BROWSER: BrowserRun;
  FILES: R2Bucket;
  LOADER: WorkerLoader;
  WORKSPACE: DurableObjectNamespace<import("./workspace").Workspace>;
  ASSETS: Fetcher;
  PersonAgent: DurableObjectNamespace<import("./index").PersonAgent>;
  ATLAS_OWNER_SECRET?: string;
  /** This deployment's own key for sealing secrets (store/sealed.ts, VISION §20): at least 32 characters, kept safe. */
  ATLAS_DATA_KEY?: string;
  ATLAS_TEST?: string;
}
