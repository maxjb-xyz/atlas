// Brave Search (VISION §9.1): about 1,000 free searches a month, card needed.
// Its free plan takes one search a second, so the core spaces calls out, and a 429 waits once.

import { type Extension, get, json, tidy } from "../sdk";

const FRESH = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

const ext: Extension = {
  manifest: {
    id: "brave",
    name: "Brave Search",
    version: "1.0.0",
    about: "Web search with Brave: $5 of free searches a month (about 1,000), card needed.",
    provides: ["search"],
    hosts: ["api.search.brave.com"],
    secrets: [{ name: "key", label: "Brave Search API key", help: "Make one at api-dashboard.search.brave.com." }],
    pace_ms: 1_100,
  },
  async search(ctx, q) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q.query)}&count=${q.count}${q.fresh ? `&freshness=${FRESH[q.fresh]}` : ""}`;
    const ask = () =>
      get(url, { headers: { "x-subscription-token": ctx.secret("key"), accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    let res = await ask();
    if (res.status === 429) {
      const wait = Math.min(5, Number(res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset")?.split(",")[0] ?? 1) || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await ask();
    }
    const body = await json<{ web?: { results?: Array<{ url?: string; title?: string; description?: string; age?: string }> } }>(
      res,
      "Brave Search",
    );
    return (body.web?.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: tidy(r.title, 200), url: r.url!, snippet: tidy(r.description), ...(r.age ? { age: r.age } : {}) }));
  },
  async test(ctx) {
    const found = await ext.search!(ctx, { query: "weather", count: 1 });
    return { text: `Brave Search answered with ${found.length} result${found.length === 1 ? "" : "s"}.` };
  },
};

export default ext;
