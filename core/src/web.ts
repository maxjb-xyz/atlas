// The web (§9.1): reading a page, and searching. Both leave Atlas (a page's
// address and a search's query go to someone else's server), so the tools
// reach them only through the outbox's `look` (§4.4), which runs the exit
// checks first and leaves a receipt. What comes back is someone else's
// words: information for Atlas, never instructions (§20).

import { paced } from "./pace";

/** A page's words: scripts, styles and tags gone, one line per block, entities decoded. Watches compare pages by this text. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** A page's title: its <title>, else its first heading. */
export function pageTitle(html: string): string {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "";
  return decode(t.replace(/<[^>]+>/g, " ")).slice(0, 200);
}

/**
 * The part of a page worth reading: its <main> or <article> when that holds
 * most of the words, else the whole body without its header, nav and
 * footer. Menus and cookie banners are noise to a reader.
 */
export function readable(html: string): string {
  const body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ");
  for (const tag of ["main", "article"]) {
    const m = new RegExp(`<${tag}[\\s>][\\s\\S]*<\\/${tag}>`, "i").exec(body)?.[0];
    if (m && pageText(m).length > 400) return blocks(m);
  }
  return blocks(body.replace(/<(header|nav|footer|aside)[\s>][\s\S]*?<\/\1>/gi, " "));
}

/** Keeps headings and list items readable in plain text. */
function blocks(html: string): string {
  return pageText(
    html
      .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n"),
  )
    .split("\n")
    .filter((l) => !/^(#+|-)$/.test(l))
    .join("\n");
}

/** The links on a page, as absolute addresses with their words, without repeats or in-page anchors. */
export function pageLinks(html: string, base: string, max = 60): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try {
      const u = new URL(decode(m[1]!), base);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      u.hash = "";
      url = u.toString();
    } catch {
      continue;
    }
    const text = decode(m[2]!.replace(/<[^>]+>/g, " ")).slice(0, 120);
    if (!text || seen.has(url)) continue;
    seen.add(url);
    out.push({ text, url });
    if (out.length >= max) break;
  }
  return out;
}

/** The most of a page Atlas reads at once, in characters (about 4,000 tokens); `start` reads on from there. */
export const PAGE_CHARS = 16_000;

/** The most of a response Atlas takes in, in bytes. */
const MAX_BYTES = 4_000_000;

export interface Page {
  /** Where it ended up, after redirects. */
  url: string;
  title: string;
  /** The readable text, from `start`, at most PAGE_CHARS. */
  text: string;
  /** How long the whole readable text is, so Atlas knows whether there's more. */
  length: number;
  links?: Array<{ text: string; url: string }>;
}

/** What a look that left Atlas came back with: the value, or the status, host and the service's own words. */
export type LookOut<T> = { ok: true; status: number; value: T; note?: string } | { ok: false; status: number; error: string };

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};

/** Reads at most MAX_BYTES of a body, so a huge download can't fill the agent's memory. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, MAX_BYTES));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, all.length - at);
    all.set(take, at);
    at += take.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/**
 * Reads a web page as text. Never throws: a failure comes back with the
 * status, the host and the site's own words. HTML becomes its readable
 * text; plain text, Markdown, JSON and XML come as they are. Anything else
 * (a PDF, an image) says what it is, since Atlas can't read it yet.
 */
export async function fetchPage(f: typeof fetch, url: string, o: { start?: number; links?: boolean } = {}): Promise<LookOut<Page>> {
  const host = hostOf(url);
  let res: Response;
  try {
    res = await f(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Atlas/1.0; personal assistant)",
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  let raw: string;
  try {
    raw = await readCapped(res);
  } catch (err) {
    return { ok: false, status: res.status, error: `Couldn't read what ${host} sent: ${err instanceof Error ? err.message : String(err)}` };
  }
  const final = res.url || url;
  if (!res.ok) {
    const words = (type.includes("html") ? pageText(raw) : raw).replace(/\s+/g, " ").trim().slice(0, 200);
    return { ok: false, status: res.status, error: `${host} answered ${res.status}${words ? `: ${words}` : ""}` };
  }
  const html = type.includes("html") || (!type && /^\s*</.test(raw));
  const textual = html || /^text\/|json|xml|markdown|javascript/.test(type);
  if (!textual)
    return {
      ok: false,
      status: res.status,
      error: `${host} sent ${type.split(";")[0] || "a file"}, which Atlas can't read yet: only web pages and text.`,
    };
  const all = html ? readable(raw) : raw.trim();
  const start = Math.max(0, Math.min(o.start ?? 0, all.length));
  return {
    ok: true,
    status: res.status,
    value: {
      url: final,
      title: html ? pageTitle(raw) : "",
      text: all.slice(start, start + PAGE_CHARS),
      length: all.length,
      ...(o.links && html ? { links: pageLinks(raw, final) } : {}),
    },
  };
}

/** One search result: where it is, what it's called, and the search's own snippet of it. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** How old it is, or when it was published, when the search says. */
  age?: string;
}

// --- search providers ---------------------------------------------------------------------
// One interface, four services. Cloudflare's runs on the AI binding every
// deployment has, paid from AI Gateway credits; the others take a key the
// owner pastes in Settings → Connections → Web search (decided with the
// owner, 2026-10-22: the default needn't be the only way, since others have
// free allowances).

export type SearchProvider = "cloudflare" | "tavily" | "brave" | "exa";
export type Freshness = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  count: number;
  fresh?: Freshness;
}

/** What each provider is called, where its queries go, and how to start with it. */
export const PROVIDERS: Record<SearchProvider, { name: string; host: string; key: boolean; about: string }> = {
  cloudflare: {
    name: "Cloudflare Web Search",
    host: "Cloudflare AI Gateway",
    key: false,
    about: "Built in, through AI Gateway. Paid from AI Gateway credits, about $0.25 per 1,000 searches.",
  },
  tavily: { name: "Tavily", host: "api.tavily.com", key: true, about: "1,000 free searches a month, no card. A key from app.tavily.com." },
  brave: {
    name: "Brave Search",
    host: "api.search.brave.com",
    key: true,
    about: "$5 of free searches a month (about 1,000), card needed. A key from api-dashboard.search.brave.com.",
  },
  exa: { name: "Exa", host: "api.exa.ai", key: true, about: "$10 of free searches a month. A key from dashboard.exa.ai." },
};

/** What the Workers AI binding's web search takes (§19.1). */
export type WebSearchBinding = (req: { gatewayId: string; query: string; limit?: number }) => Promise<Response>;

const tidy = (s: unknown, n = 400) =>
  typeof s === "string"
    ? decode(s.replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .slice(0, n)
    : "";

const DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 31, year: 366 };

/** Turns an answer that isn't results into the service's own words, with the status and where it came from. */
async function refused(res: Response, who: string, hint = ""): Promise<LookOut<never>> {
  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: false, status: res.status, error: `${who} answered ${res.status}${text ? `: ${text}` : ""}${hint}` };
}

/**
 * Searches with the chosen provider. Never throws: a failure comes back
 * with the status, the host and the service's own words, and for
 * Cloudflare's credits or a missing key, what to do about it.
 */
export async function search(
  provider: SearchProvider,
  q: SearchQuery,
  o: { fetch: typeof fetch; key: string | null; binding: WebSearchBinding | null },
): Promise<LookOut<SearchResult[]>> {
  const p = PROVIDERS[provider];
  if (p.key && !o.key)
    return { ok: false, status: 0, error: `${p.name} needs its key. The owner adds it in Settings → Connections → Web search.` };
  const count = Math.min(Math.max(q.count, 1), 20);
  const signal = AbortSignal.timeout(15_000);
  let res: Response;
  try {
    switch (provider) {
      case "cloudflare": {
        if (!o.binding)
          return { ok: false, status: 0, error: "This deployment has no Workers AI binding, so Cloudflare Web Search can't run." };
        res = await o.binding({ gatewayId: "default", query: q.query, limit: count });
        if (!res.ok)
          return refused(
            res,
            p.name,
            res.status === 402 || res.status === 401 || res.status === 403
              ? ". It's paid from AI Gateway credits (Cloudflare dashboard → AI → AI Gateway → Credits). Or pick another search in Settings → Connections → Web search: Tavily has 1,000 free searches a month."
              : "",
          );
        const body = (await res.json()) as { items?: Array<{ url?: string; title?: string; description?: string }> };
        if (!Array.isArray(body.items))
          return { ok: false, status: res.status, error: `${p.name} sent no results: ${JSON.stringify(body).slice(0, 200)}` };
        return {
          ok: true,
          status: res.status,
          value: body.items.filter((i) => i.url).map((i) => ({ title: tidy(i.title, 200), url: i.url!, snippet: tidy(i.description) })),
          ...(q.fresh ? { note: "Cloudflare Web Search can't filter by date, so results may be older." } : {}),
        };
      }
      case "tavily": {
        res = await o.fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" },
          body: JSON.stringify({ query: q.query, max_results: count, search_depth: "basic", ...(q.fresh ? { time_range: q.fresh } : {}) }),
          signal,
        });
        if (!res.ok) return refused(res, p.host);
        const body = (await res.json()) as { results?: Array<{ url?: string; title?: string; content?: string; published_date?: string }> };
        return {
          ok: true,
          status: res.status,
          value: (body.results ?? [])
            .filter((r) => r.url)
            .map((r) => ({
              title: tidy(r.title, 200),
              url: r.url!,
              snippet: tidy(r.content),
              ...(r.published_date ? { age: r.published_date } : {}),
            })),
        };
      }
      case "brave": {
        const fresh = q.fresh ? `&freshness=${{ day: "pd", week: "pw", month: "pm", year: "py" }[q.fresh]}` : "";
        // Brave's free plan takes one search a second, and a run often asks several at once: they're spaced out, and a 429 waits once.
        const ask = () =>
          paced(p.host, 1_100, () =>
            o.fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q.query)}&count=${count}${fresh}`, {
              headers: { "x-subscription-token": o.key!, accept: "application/json" },
              // Its own timeout, from when it's sent, so waiting its turn doesn't use it up.
              signal: AbortSignal.timeout(15_000),
            }),
          );
        res = await ask();
        if (res.status === 429) {
          const wait = Math.min(5, Number(res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset")?.split(",")[0] ?? 1) || 1);
          await new Promise((r) => setTimeout(r, wait * 1000));
          res = await ask();
        }
        if (!res.ok) return refused(res, p.host);
        const body = (await res.json()) as {
          web?: { results?: Array<{ url?: string; title?: string; description?: string; age?: string }> };
        };
        return {
          ok: true,
          status: res.status,
          value: (body.web?.results ?? [])
            .filter((r) => r.url)
            .map((r) => ({ title: tidy(r.title, 200), url: r.url!, snippet: tidy(r.description), ...(r.age ? { age: r.age } : {}) })),
        };
      }
      case "exa": {
        const since = q.fresh ? new Date(Date.now() - DAYS[q.fresh] * 86_400_000).toISOString() : null;
        res = await o.fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: { "x-api-key": o.key!, "content-type": "application/json" },
          body: JSON.stringify({
            query: q.query,
            type: "auto",
            numResults: count,
            contents: { highlights: true },
            ...(since ? { startPublishedDate: since } : {}),
          }),
          signal,
        });
        if (!res.ok) return refused(res, p.host);
        const body = (await res.json()) as {
          results?: Array<{ url?: string; title?: string; highlights?: string[]; text?: string; publishedDate?: string }>;
        };
        return {
          ok: true,
          status: res.status,
          value: (body.results ?? [])
            .filter((r) => r.url)
            .map((r) => ({
              title: tidy(r.title, 200),
              url: r.url!,
              snippet: tidy(r.highlights?.join(" … ") ?? r.text),
              ...(r.publishedDate ? { age: r.publishedDate.slice(0, 10) } : {}),
            })),
        };
      }
    }
  } catch (err) {
    return { ok: false, status: 0, error: `Couldn't reach ${p.host}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
