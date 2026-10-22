// Webhooks the owner sets up (§13.3: "post to a channel", "turn off the
// lights"): a name, an address and what it does. The address is the
// credential (a Home Assistant webhook id, an IFTTT key), so webhooks are
// kept with the secrets and the app only sees their names and hosts. Calling
// one goes through the outbox (§4.4), after the owner's OK when Atlas asks.

import { newId, type Sql } from "./store/db";
import { getSecret, setSecret } from "./store/settings";

export interface Webhook {
  id: string;
  name: string;
  url: string;
  method: "POST" | "GET";
  /** What it does, in the owner's words, so Atlas knows when to use it. */
  about: string;
}

/** A webhook as the app and the model see it: no address, only its host. */
export interface WebhookView {
  id: string;
  name: string;
  host: string;
  method: "POST" | "GET";
  about: string;
}

export const webhooks = (sql: Sql): Webhook[] => getSecret<Webhook[]>(sql, "webhooks") ?? [];

export const webhookView = (w: Webhook): WebhookView => ({ id: w.id, name: w.name, host: hostOf(w.url), method: w.method, about: w.about });

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
};

/** Adds a webhook, or changes one; an empty `url` on a change keeps the address it had. */
export function saveWebhook(sql: Sql, w: { id?: string; name: string; url?: string; method: "POST" | "GET"; about: string }): Webhook {
  const all = webhooks(sql);
  const old = w.id ? all.find((x) => x.id === w.id) : undefined;
  if (w.id && !old) throw new Error("That webhook isn't there any more.");
  const url = w.url?.trim() || old?.url;
  if (!url) throw new Error("A webhook needs its address.");
  if (!/^https:\/\//.test(url)) throw new Error("The address has to start with https://.");
  const name = w.name.trim();
  if (all.some((x) => x.id !== old?.id && x.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`There's already a webhook called ${name}.`);
  const hook: Webhook = { id: old?.id ?? newId("wh"), name, url, method: w.method, about: w.about.trim() };
  setSecret(sql, "webhooks", [...all.filter((x) => x.id !== hook.id), hook]);
  return hook;
}

export function removeWebhook(sql: Sql, id: string): Webhook | null {
  const all = webhooks(sql);
  const gone = all.find((x) => x.id === id) ?? null;
  setSecret(
    sql,
    "webhooks",
    all.filter((x) => x.id !== id),
  );
  return gone;
}

export function findWebhook(sql: Sql, nameOrId: string): Webhook | null {
  const want = nameOrId.trim().toLowerCase();
  return webhooks(sql).find((w) => w.id === nameOrId || w.name.toLowerCase() === want) ?? null;
}

export interface WebhookOutcome {
  ok: boolean;
  status: number;
  /** What happened, with the host: the status, and on failure its own words. */
  answer: string;
  /** The start of what it answered. */
  reply: string;
}

/** Calls a webhook. Never throws: a failure comes back with the status, the host and its own words. */
export async function callWebhook(f: typeof fetch, w: Webhook, o: { message?: string; from: string }): Promise<WebhookOutcome> {
  const host = hostOf(w.url);
  try {
    const res = await f(w.url, {
      method: w.method,
      ...(w.method === "POST"
        ? {
            headers: { "content-type": "application/json", "user-agent": "Atlas" },
            body: JSON.stringify({ text: o.message ?? w.name, from: o.from, at: new Date().toISOString() }),
          }
        : { headers: { "user-agent": "Atlas" } }),
      signal: AbortSignal.timeout(15_000),
    });
    const words = (await res.text().catch(() => "")).trim().slice(0, 200);
    return {
      ok: res.ok,
      status: res.status,
      answer: res.ok ? `${host} answered ${res.status}` : `${host} answered ${res.status}${words ? `: ${words}` : ""}`,
      reply: words,
    };
  } catch (err) {
    return { ok: false, status: 0, answer: `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}`, reply: "" };
  }
}
