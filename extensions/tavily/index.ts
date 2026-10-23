// Tavily web search (VISION §9.1): 1,000 free searches a month, no card.

import { type Extension, get, json, tidy } from "../sdk";

const ext: Extension = {
  manifest: {
    id: "tavily",
    name: "Tavily",
    version: "1.0.0",
    about: "Web search with Tavily: 1,000 free searches a month, no card needed.",
    provides: ["search"],
    hosts: ["api.tavily.com"],
    secrets: [{ name: "key", label: "Tavily API key", help: "Make one at app.tavily.com." }],
  },
  async search(ctx, q) {
    const res = await get("https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.secret("key")}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q.query, max_results: q.count, search_depth: "basic", ...(q.fresh ? { time_range: q.fresh } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await json<{ results?: Array<{ url?: string; title?: string; content?: string; published_date?: string }> }>(
      res,
      "Tavily",
    );
    return (body.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: tidy(r.title, 200),
        url: r.url!,
        snippet: tidy(r.content),
        ...(r.published_date ? { age: r.published_date } : {}),
      }));
  },
  async test(ctx) {
    const found = await ext.search!(ctx, { query: "weather", count: 1 });
    return { text: `Tavily answered with ${found.length} result${found.length === 1 ? "" : "s"}.` };
  },
};

export default ext;
