// The web (§9.1): reading a page, and searching. Both leave Atlas (a page's
// address and a search's query go to someone else's server), so the tools
// reach them only through the outbox's `look` (§4.4), which runs the exit
// checks first and leaves a receipt. What comes back is someone else's
// words: information for Atlas, never instructions (§20).

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

export type { SearchResult } from "../../extensions/sdk";
import type { SearchResult } from "../../extensions/sdk";

// --- search ------------------------------------------------------------------------------------
// Cloudflare's web search runs on the AI binding every deployment has, paid
// from AI Gateway credits: it's the platform, so it's the core's (§17).
// Other searches (Tavily, Brave, Exa) are extensions, picked in Settings →
// Connections → Web search (decided with the owner, 2026-10-22: the default
// needn't be the only way, since others have free allowances).

/** The search the owner picked: "cloudflare", or a search extension's id. */
export type SearchProvider = string;
export type Freshness = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  count: number;
  fresh?: Freshness;
}

export const CLOUDFLARE_SEARCH = {
  name: "Cloudflare Web Search",
  about: "Built in, through AI Gateway. Paid from AI Gateway credits, about $0.25 per 1,000 searches.",
};

/** What the Workers AI binding's web search takes (§19.1). */
export type WebSearchBinding = (req: { gatewayId: string; query: string; limit?: number }) => Promise<Response>;

const tidy = (s: unknown, n = 400) =>
  typeof s === "string"
    ? decode(s.replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .slice(0, n)
    : "";

/** Turns an answer that isn't results into the service's own words, with the status and where it came from. */
async function refused(res: Response, who: string, hint = ""): Promise<LookOut<never>> {
  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: false, status: res.status, error: `${who} answered ${res.status}${text ? `: ${text}` : ""}${hint}` };
}

/**
 * Searches with Cloudflare's web search. Never throws: a failure comes back
 * with the status and the service's own words, and for credits, what to do.
 */
export async function cloudflareSearch(binding: WebSearchBinding | null, q: SearchQuery): Promise<LookOut<SearchResult[]>> {
  const name = CLOUDFLARE_SEARCH.name;
  if (!binding) return { ok: false, status: 0, error: "This deployment has no Workers AI binding, so Cloudflare Web Search can't run." };
  const count = Math.min(Math.max(q.count, 1), 20);
  try {
    const res = await binding({ gatewayId: "default", query: q.query, limit: count });
    if (!res.ok)
      return refused(
        res,
        name,
        res.status === 402 || res.status === 401 || res.status === 403
          ? ". It's paid from AI Gateway credits (Cloudflare dashboard → AI → AI Gateway → Credits). Or pick another search in Settings → Connections → Web search: the Tavily extension has 1,000 free searches a month."
          : "",
      );
    const body = (await res.json()) as { items?: Array<{ url?: string; title?: string; description?: string }> };
    if (!Array.isArray(body.items))
      return { ok: false, status: res.status, error: `${name} sent no results: ${JSON.stringify(body).slice(0, 200)}` };
    return {
      ok: true,
      status: res.status,
      value: body.items.filter((i) => i.url).map((i) => ({ title: tidy(i.title, 200), url: i.url!, snippet: tidy(i.description) })),
      ...(q.fresh ? { note: "Cloudflare Web Search can't filter by date, so results may be older." } : {}),
    };
  } catch (err) {
    return { ok: false, status: 0, error: `Couldn't reach ${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- site icons ----------------------------------------------------------------------------------
// A source in the thread shows its site's own mark (M7 W17). Only the host leaves Atlas: the site's front page is
// read for the icon it names, or its /favicon.ico is asked for. Nothing about the owner goes with it.

/** A host worth asking: a plain public domain name, no port, no address, no login. */
export const iconHost = (host: string) =>
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && !/(^|\.)(localhost|local|internal|arpa)$/.test(host);

const ICON_BYTES = 200_000;
const UA = "Mozilla/5.0 (compatible; Atlas/1.0; personal assistant)";

/** The icons a page names, best first: big enough to stay sharp at twice the size shown, and not much bigger. */
export function iconLinks(html: string, base: string): string[] {
  const found: Array<{ url: string; score: number }> = [];
  for (const m of html.slice(0, 200_000).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:") || /\.svg(\?|$)/i.test(href)) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? (rel.includes("apple") ? 180 : 16));
    let url: string;
    try {
      url = new URL(decode(href), base).toString();
    } catch {
      continue;
    }
    if (/^https:/.test(url) && !found.some((x) => x.url === url))
      found.push({ url, score: size >= 48 ? 2000 - Math.abs(size - 96) : size * 10 });
  }
  return found.sort((x, y) => y.score - x.score).map((x) => x.url);
}

async function iconAt(f: typeof fetch, url: string): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  const res = await f(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "image/*" },
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const kind = type.startsWith("image/") ? type : /\.ico(\?|$)/.test(url) ? "image/x-icon" : /\.png(\?|$)/.test(url) ? "image/png" : "";
  if (!kind || kind === "image/svg+xml") return null;
  const bytes = await res.arrayBuffer().catch(() => null);
  if (!bytes || bytes.byteLength < 40 || bytes.byteLength > ICON_BYTES) return null;
  return { type: kind, bytes };
}

/** A site's icon, or null when it has none Atlas can show. Never throws. */
export async function siteIcon(f: typeof fetch, host: string): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  if (!iconHost(host)) return null;
  const base = `https://${host}/`;
  const res = await f(base, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  const html = res?.ok && (res.headers.get("content-type") ?? "").includes("html") ? await readCapped(res).catch(() => "") : "";
  if (res && !html) await res.body?.cancel().catch(() => {});
  for (const url of html ? iconLinks(html, res!.url || base).slice(0, 3) : []) {
    const got = await iconAt(f, url);
    if (got) return got;
  }
  return iconAt(f, new URL("/favicon.ico", res?.url || base).toString());
}
