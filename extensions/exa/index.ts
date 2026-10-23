// Exa web search (VISION §9.1): $10 of free searches a month.

import { type Extension, get, json, tidy } from "../sdk";

const DAYS = { day: 1, week: 7, month: 31, year: 366 } as const;

const ext: Extension = {
  manifest: {
    id: "exa",
    name: "Exa",
    version: "1.0.0",
    about: "Web search with Exa: $10 of free searches a month.",
    provides: ["search"],
    hosts: ["api.exa.ai"],
    secrets: [{ name: "key", label: "Exa API key", help: "Make one at dashboard.exa.ai." }],
  },
  async search(ctx, q) {
    const since = q.fresh ? new Date(ctx.now - DAYS[q.fresh] * 86_400_000).toISOString() : null;
    const res = await get("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": ctx.secret("key"), "content-type": "application/json" },
      body: JSON.stringify({
        query: q.query,
        type: "auto",
        numResults: q.count,
        contents: { highlights: true },
        ...(since ? { startPublishedDate: since } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await json<{
      results?: Array<{ url?: string; title?: string; highlights?: string[]; text?: string; publishedDate?: string }>;
    }>(res, "Exa");
    return (body.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: tidy(r.title, 200),
        url: r.url!,
        snippet: tidy(r.highlights?.join(" … ") ?? r.text),
        ...(r.publishedDate ? { age: r.publishedDate.slice(0, 10) } : {}),
      }));
  },
  async test(ctx) {
    const found = await ext.search!(ctx, { query: "weather", count: 1 });
    return { text: `Exa answered with ${found.length} result${found.length === 1 ? "" : "s"}.` };
  },
};

export default ext;
