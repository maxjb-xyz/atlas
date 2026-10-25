// What each brain costs, and what Atlas has spent on them (§18). Providers'
// model lists don't say what a model costs, except Workers AI's, so the
// prices are a small table kept from the providers' pricing pages, dated,
// and a model that isn't in it shows no price rather than a guess. Speed
// isn't in any catalog: the router measures it from Atlas's own runs.
//
// Read on 2026-10-25:
// - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   (base input, 5-minute cache writes, cache hits, output, per million tokens).
// - Workers AI: https://developers.cloudflare.com/workers-ai/platform/pricing/
//   ($0.011 per 1,000 neurons past a free 10,000 neurons a day, which resets at
//   00:00 UTC; each model's price per million tokens as that page lists it; the
//   models marked "paid billing" need Workers Paid or AI Gateway credits).
// - ChatGPT on the owner's plan has no price per token: the plan is flat.

/** A call's tokens, as brains count them (types.ts's Usage; kept apart so the app can read this file). */
interface Tokens {
  input: number;
  output: number;
  cached?: number;
  written?: number;
}

/** US dollars per million tokens. */
export interface Price {
  in: number;
  out: number;
  /** Input read from the cache. */
  cached?: number;
  /** Input written to the cache (Anthropic's 5-minute writes). */
  written?: number;
  /** Workers AI: only on Workers Paid (or AI Gateway credits). */
  paid_plan?: boolean;
}

/** A model in a provider's catalog, for the pickers. */
export interface ModelInfo {
  id: string;
  name: string;
  price?: Price | null;
  /** Its context window, in tokens, when the catalog says. */
  context?: number;
}

export const PRICES_AS_OF = "2026-10-25";

const fable: Price = { in: 10, written: 12.5, cached: 1, out: 50 };
const opus5: Price = { in: 5, written: 6.25, cached: 0.5, out: 25 };
const opus41: Price = { in: 15, written: 18.75, cached: 1.5, out: 75 };
const sonnet4: Price = { in: 3, written: 3.75, cached: 0.3, out: 15 };

/** Anthropic's models by id; a dated id ("claude-opus-4-5-20251101") takes its model's price. */
const ANTHROPIC: Record<string, Price> = {
  "claude-fable-5-1": { ...fable, cached: 0.25 },
  "claude-mythos-5-1": { ...fable, cached: 0.25 },
  "claude-fable-5": fable,
  "claude-mythos-5": fable,
  "claude-opus-5-5": { in: 4, written: 5, cached: 0.2, out: 20 },
  "claude-opus-5": opus5,
  "claude-opus-4-8": opus5,
  "claude-opus-4-7": opus5,
  "claude-opus-4-6": opus5,
  "claude-opus-4-5": opus5,
  "claude-opus-4-1": opus41,
  "claude-opus-4": opus41,
  "claude-sonnet-5-5": { in: 2, written: 2.5, cached: 0.1, out: 10 },
  "claude-sonnet-5": { in: 2, written: 2.5, cached: 0.2, out: 10 },
  "claude-sonnet-4-6": sonnet4,
  "claude-sonnet-4-5": sonnet4,
  "claude-sonnet-4": sonnet4,
  // For prompts up to 100K tokens; past that, $0.50 in and $2.50 out.
  "claude-haiku-5-5": { in: 0.1, written: 0.125, cached: 0.01, out: 0.5 },
  "claude-haiku-4-5": { in: 1, written: 1.25, cached: 0.1, out: 5 },
};

const paid = (p: Price): Price => ({ ...p, paid_plan: true });

/** Workers AI's text models by the last part of their id ("kimi-k2.6" for "@cf/moonshotai/kimi-k2.6"). */
const WORKERS_AI: Record<string, Price> = {
  "kimi-k2.5": { in: 0.6, cached: 0.1, out: 3 },
  "kimi-k2.6": paid({ in: 0.95, cached: 0.16, out: 4 }),
  "kimi-k2.7-code": paid({ in: 0.95, cached: 0.19, out: 4 }),
  "glm-4.7-flash": { in: 0.06, out: 0.4 },
  "glm-5.2": paid({ in: 1.4, cached: 0.26, out: 4.4 }),
  "glm-5.3": paid({ in: 1.4, cached: 0.26, out: 4.4 }),
  "glm-5.3-flash": paid({ in: 0.15, cached: 0.03, out: 0.5 }),
  "qwq-32b": { in: 0.66, out: 1 },
  "qwen2.5-coder-32b-instruct": { in: 0.66, out: 1 },
  "qwen3-30b-a3b-fp8": { in: 0.051, out: 0.335 },
  "qwen3.8-27b": { in: 0.45, out: 3.2 },
  "llama-3.2-1b-instruct": { in: 0.027, out: 0.201 },
  "llama-3.2-3b-instruct": { in: 0.051, out: 0.335 },
  "llama-3.1-8b-instruct-fp8-fast": { in: 0.045, out: 0.384 },
  "llama-3.1-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "llama-4-scout-17b-16e-instruct": { in: 0.27, out: 0.85 },
  "gpt-oss-120b": { in: 0.35, out: 0.75 },
  "gpt-oss-20b": { in: 0.2, out: 0.3 },
  "gemma-3-12b-it": { in: 0.345, out: 0.556 },
  "gemma-4-26b-a4b-it": { in: 0.1, out: 0.3 },
  "mistral-small-3.1-24b-instruct": { in: 0.351, out: 0.555 },
  "deepseek-v4-flash-0731": paid({ in: 0.44, cached: 0.014, out: 1.32 }),
  "deepseek-v4.1-flash-1017": paid({ in: 0.3, cached: 0.006, out: 1.2 }),
  "deepseek-v4-pro-0813": paid({ in: 1.32, cached: 0.044, out: 3.96 }),
  "nemotron-3-120b-a12b": { in: 0.5, out: 1.5 },
  "granite-4.0-h-micro": { in: 0.017, out: 0.112 },
};

/** Workers AI past its free allowance: dollars per neuron. */
export const NEURON_USD = 0.011 / 1_000;
/** Workers AI's free allowance, in neurons a day (UTC). */
export const FREE_NEURONS = 10_000;

/** A brain's price, or null when it has none per token (ChatGPT's plan) or isn't in the table. */
export function priceOf(b: { provider: string; model: string }): Price | null {
  if (b.provider === "anthropic") {
    const dated = b.model.replace(/-\d{8}$/, "");
    return ANTHROPIC[b.model] ?? ANTHROPIC[dated] ?? null;
  }
  if (b.provider === "workers-ai") return WORKERS_AI[b.model.split("/").pop() ?? b.model] ?? null;
  return null;
}

/** What a call cost in dollars at a price, or null with no price. */
export function costOf(b: { provider: string; model: string }, u: Tokens, price: Price | null = priceOf(b)): number | null {
  if (!price) return null;
  const cached = u.cached ?? 0;
  const written = u.written ?? 0;
  const plain = Math.max(0, u.input - cached - written);
  return (plain * price.in + cached * (price.cached ?? price.in) + written * (price.written ?? price.in) + u.output * price.out) / 1e6;
}

/** Brains billed for what they use, by key, which the spending cap covers (§12.3, §18). */
export const isPaid = (b: { provider: string }) => b.provider === "anthropic";

// --- what's been spent ---------------------------------------------------

/** Spending by brain this month (UTC, as Anthropic bills), and Workers AI's neurons today (UTC, as its allowance resets). */
export interface Spend {
  month: string;
  usd: Record<string, number>;
  day: string;
  neurons: number;
}

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The next 00:00 UTC, when Workers AI's allowance resets. */
export function nextDayUtc(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** 00:00 UTC on the first of next month, when a month's spending starts again. */
export function nextMonthUtc(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The ledger as of now: a new month or day starts from nothing. */
export function current(s: Spend | null, now: number): Spend {
  const month = monthOf(now);
  const day = dayOf(now);
  return {
    month,
    usd: s && s.month === month ? s.usd : {},
    day,
    neurons: s && s.day === day ? s.neurons : 0,
  };
}

/** Adds one call's cost to the ledger. */
export function addSpend(s: Spend | null, b: { provider: string; model: string }, usd: number, now: number): Spend {
  const next = current(s, now);
  const key = `${b.provider}:${b.model}`;
  next.usd = { ...next.usd, [key]: (next.usd[key] ?? 0) + usd };
  if (b.provider === "workers-ai") next.neurons += usd / NEURON_USD;
  return next;
}

/** What paid brains have cost this month. */
export function paidThisMonth(s: Spend | null, now: number): number {
  const c = current(s, now);
  return Object.entries(c.usd)
    .filter(([k]) => isPaid({ provider: k.split(":")[0]! }))
    .reduce((sum, [, v]) => sum + v, 0);
}

/** Dollars in words: "$0.42", "$12", "under a cent". */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under a cent";
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

// --- catalogs -------------------------------------------------------------

interface CatalogEntry {
  name?: string;
  task?: { name?: string };
  properties?: Array<{ property_id?: string; value?: unknown }>;
}

/** The binding's catalog: `env.AI.models()`, the same search as the REST API's, without a token. */
export interface AiCatalog {
  models(params?: { task?: string; page?: number; per_page?: number; hide_experimental?: boolean }): Promise<CatalogEntry[]>;
}

/**
 * A price as Workers AI's catalog gives it: a list of `{ unit, price }` or
 * the line its model pages show ("$0.95 per M input tokens, $4.00 per M
 * output tokens, $0.16 per M cached input tokens").
 */
export function catalogPrice(value: unknown): Price | null {
  const parts: Array<{ unit: string; price: number }> = [];
  if (Array.isArray(value)) {
    for (const v of value as Array<{ unit?: unknown; price?: unknown }>) {
      if (typeof v?.unit === "string" && typeof v.price === "number") parts.push({ unit: v.unit, price: v.price });
    }
  } else if (typeof value === "string") {
    for (const m of value.matchAll(/\$\s*([\d.]+)\s*per\s*M\s*([a-z ]+?)tokens/gi)) parts.push({ unit: m[2]!, price: Number(m[1]) });
  }
  const pick = (re: RegExp) => parts.find((p) => re.test(p.unit))?.price;
  const cached = pick(/cached/i);
  const input = parts.find((p) => /input/i.test(p.unit) && !/cached/i.test(p.unit))?.price;
  const output = pick(/output/i);
  if (input == null || output == null) return null;
  return { in: input, out: output, ...(cached != null ? { cached } : {}) };
}

/**
 * Workers AI's text models that take tools, from the binding's catalog, each
 * with its price: the catalog's own when it gives one, else the table's.
 */
export async function workersAIModels(ai: AiCatalog): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ai.models({ task: "Text Generation", per_page: 100, page, hide_experimental: true });
    for (const m of batch) {
      if (!m.name || (m.task?.name && m.task.name !== "Text Generation")) continue;
      const prop = (id: string) => m.properties?.find((p) => p.property_id === id)?.value;
      const tools = prop("function_calling");
      if (!(tools === true || tools === "true")) continue;
      const context = Number(prop("context_window") ?? NaN);
      const table = priceOf({ provider: "workers-ai", model: m.name });
      const listed = catalogPrice(prop("price"));
      out.push({
        id: m.name,
        name: m.name.split("/").pop() ?? m.name,
        price: listed ? { ...listed, ...(table?.paid_plan ? { paid_plan: true } : {}) } : table,
        ...(Number.isFinite(context) && context > 0 ? { context } : {}),
      });
    }
    if (batch.length < 100) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
