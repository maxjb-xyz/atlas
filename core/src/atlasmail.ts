// Atlas's own address (VISION §16.2): atlas@ the owner's domain, which may
// live in another Cloudflare account than Atlas. With a token for the
// domain's account, Atlas puts a small relay Worker and a routing rule there:
// Email Routing hands each mail to the relay, which posts it here signed with
// a key only the two share. When the domain's mail goes to another provider,
// the address is on a subdomain, so nothing the owner has changes. Sending is
// Cloudflare Email Service from that account (it needs Workers Paid there),
// or an extension that sends (Resend). All of it is the Cloudflare platform
// and open standards, so it's core; Resend is the extension.

import type { Sql } from "./store/db";
import { getSecret, setSecret } from "./store/settings";
import { getState, setState } from "./store/state";

const API = "https://api.cloudflare.com/client/v4";
export const RELAY_SCRIPT = "atlas-mail-relay";
/** The subdomain used when the domain's mail goes to another provider. */
export const SUBDOMAIN = "atlas";
/** A relayed mail older than this is refused, so a captured post can't be replayed. */
const RELAY_WINDOW_MS = 10 * 60_000;

export interface AtlasMail {
  /** The domain the owner gave, and the one the address is on (the same, or a subdomain of it). */
  domain: string;
  mail_domain: string;
  address: string;
  zone_id: string;
  account_id: string;
  /** Who sends: Cloudflare Email Service, or an extension's id. */
  sending: string;
  /** Whether sending was set up, and if not, what Cloudflare or the extension said. */
  sending_ok: boolean;
  sending_note: string | null;
  rule_id: string | null;
  made_at: number;
}

export const atlasMail = (sql: Sql): AtlasMail | null => getState<AtlasMail>(sql, "atlas_mail");

/**
 * What the domain's account token needs, in Cloudflare's own words, with the
 * key its "Create token" link takes (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
 */
export const TOKEN_PERMISSIONS: TokenPermission[] = [
  { text: "Account · Workers Scripts · Edit", why: "for the relay Worker", key: "workers_scripts", type: "edit" },
  { text: "Zone · Email Routing Rules · Edit", why: "for the rule that sends Atlas's mail to it", key: "email_routing_rule", type: "edit" },
  { text: "Zone · Zone Settings · Edit", why: "to turn on Email Routing and sending", key: "zone_settings", type: "edit" },
  { text: "Zone · DNS · Edit", why: "for Email Routing's records, and Resend's when it sends", key: "dns", type: "edit" },
  { text: "Zone · Zone · Read", why: "to find the domain", key: "zone", type: "read" },
  { text: "Account · Email Sending · Edit", why: "only when Cloudflare sends", key: "email_sending", type: "edit", cloudflare: true },
];

export interface TokenPermission {
  text: string;
  why: string;
  key: string;
  type: "read" | "edit";
  /** Only needed when Cloudflare sends Atlas's mail. */
  cloudflare?: boolean;
}

/**
 * Cloudflare's "Create token" page with the permissions filled in, for every
 * zone; the owner can narrow it to the one domain there before making it.
 */
export function tokenLink(cloudflareSends: boolean): string {
  const keys = TOKEN_PERMISSIONS.filter((p) => cloudflareSends || !p.cloudflare).map((p) => ({ key: p.key, type: p.type }));
  const q = new URLSearchParams({ permissionGroupKeys: JSON.stringify(keys), accountId: "*", zoneId: "all", name: "Atlas mail" });
  return `https://dash.cloudflare.com/profile/api-tokens?${q.toString()}`;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Cloudflare's own error codes, such as 10220 for a rollback past a changed secret. */
    readonly codes: number[] = [],
  ) {
    super(message);
  }
}

/** One call to Cloudflare's API with the domain's token. Its errors keep the status, the path and Cloudflare's own words. */
export async function cf<T>(f: typeof fetch, token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  } catch (err) {
    throw new CloudflareError(`Couldn't reach Cloudflare's API (${err instanceof Error ? err.message : String(err)}).`, 0);
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ code?: number; message?: string }>;
  } | null;
  if (!res.ok || body?.success === false) {
    const said =
      (body?.errors ?? []).map((e) => `${e.message ?? "error"}${e.code ? ` (${e.code})` : ""}`).join("; ") || `HTTP ${res.status}`;
    const method = (init.method ?? "GET").toUpperCase();
    throw new CloudflareError(
      `Cloudflare said: ${said} (HTTP ${res.status}, ${method} ${path.split("?")[0]})`,
      res.status,
      (body?.errors ?? []).map((e) => e.code ?? 0).filter((c) => c > 0),
    );
  }
  return body?.result as T;
}

/** The relay Worker that runs in the domain's account: each mail to Atlas's address, posted to Atlas signed. */
export const RELAY_SOURCE = `// Atlas's mail relay (made by Atlas; see Settings → Connections → Atlas's email in your Atlas).
// Email Routing hands it each mail to Atlas's address; it posts the mail, as it came, to your Atlas,
// signed with a key only the two share. If Atlas doesn't take it, the mail is tried again later.
export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const time = String(Date.now());
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.RELAY_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const head = new TextEncoder().encode(time + ".");
    const signed = new Uint8Array(head.length + raw.length);
    signed.set(head);
    signed.set(raw, head.length);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, signed))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch(env.ATLAS_URL + "/mail/in", {
      method: "POST",
      headers: { "x-atlas-time": time, "x-atlas-signature": sig, "x-atlas-from": message.from, "x-atlas-to": message.to, "content-type": "message/rfc822" },
      body: raw,
    });
    if (!res.ok) throw new Error("Atlas didn't take the mail (HTTP " + res.status + "): " + (await res.text()).slice(0, 200));
  },
};
`;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Checks a relayed post: signed with the relay's key over its time and the mail, and recent. */
export async function relayAllowed(
  sql: Sql,
  time: string | null,
  signature: string | null,
  body: Uint8Array,
  now = Date.now(),
): Promise<boolean> {
  const key = getSecret<string>(sql, "mail_relay");
  if (!key || !time || !signature || !/^\d{10,16}$/.test(time) || Math.abs(now - Number(time)) > RELAY_WINDOW_MS) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const head = new TextEncoder().encode(`${time}.`);
  const signed = new Uint8Array(head.length + body.length);
  signed.set(head);
  signed.set(body, head.length);
  const want = hex(await crypto.subtle.sign("HMAC", k, signed));
  const got = signature.toLowerCase();
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

interface Zone {
  id: string;
  name: string;
  account: { id: string; name?: string };
}

/**
 * Puts Atlas's address in place on the owner's domain: finds the zone, sees
 * where its mail goes, turns on Email Routing there (on a subdomain when
 * the domain's mail goes elsewhere), puts the relay Worker and its rule in
 * place, and, when Cloudflare sends, a sending domain. Each step's failure
 * says what Cloudflare said. Run again, it changes only what's missing.
 */
export async function setUpAtlasMail(
  sql: Sql,
  f: typeof fetch,
  o: { token: string; domain: string; origin: string; sending: string; local?: string },
): Promise<{ mail: AtlasMail; notes: string[] }> {
  const domain = o.domain.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  const notes: string[] = [];
  // The zone: the domain itself, or the zone it's under.
  const parts = domain.split(".");
  let zone: Zone | null = null;
  for (let i = 0; i < parts.length - 1 && !zone; i++) {
    const name = parts.slice(i).join(".");
    const found = await cf<Zone[]>(f, o.token, `/zones?name=${encodeURIComponent(name)}`);
    zone = found[0] ?? null;
  }
  if (!zone)
    throw new CloudflareError(
      `The token can't see ${domain} on Cloudflare. Make it for the account the domain is in, with Zone · Zone · Read, and that domain under Zone Resources.`,
      404,
    );
  // Where the domain's mail goes now: Cloudflare's Email Routing (or nowhere) keeps the domain; anything else, a subdomain.
  const mx = await cf<Array<{ content: string; name: string }>>(
    f,
    o.token,
    `/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(domain)}`,
  );
  const elsewhere = mx.filter((r) => !/\.mx\.cloudflare\.net\.?$/i.test(r.content));
  const mail_domain = elsewhere.length ? `${SUBDOMAIN}.${domain}` : domain;
  if (elsewhere.length)
    notes.push(
      `${domain}'s mail goes to ${elsewhere[0]!.content}, so Atlas's address is on ${mail_domain}, and nothing about your own mail changes.`,
    );
  // Email Routing on the address's domain.
  const routing = await cf<{ enabled?: boolean; status?: string } | null>(f, o.token, `/zones/${zone.id}/email/routing`).catch(() => null);
  if (mail_domain !== zone.name || !routing?.enabled)
    await cf(f, o.token, `/zones/${zone.id}/email/routing/dns`, {
      method: "POST",
      body: JSON.stringify(mail_domain === zone.name ? {} : { name: mail_domain }),
    });
  // The relay, with a key only it and Atlas know.
  let key = getSecret<string>(sql, "mail_relay");
  if (!key) {
    key = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    setSecret(sql, "mail_relay", key);
  }
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "relay.js",
          compatibility_date: "2026-10-01",
          bindings: [
            { type: "secret_text", name: "RELAY_KEY", text: key },
            { type: "plain_text", name: "ATLAS_URL", text: o.origin },
          ],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set("relay.js", new Blob([RELAY_SOURCE], { type: "application/javascript+module" }), "relay.js");
  await cf(f, o.token, `/accounts/${zone.account.id}/workers/scripts/${RELAY_SCRIPT}`, { method: "PUT", body: form });
  // The rule: Atlas's address to the relay, beside the rules already there.
  const address = `${(o.local ?? "atlas").toLowerCase()}@${mail_domain}`;
  const rules = await cf<Array<{ id: string; matchers?: Array<{ value?: string }>; actions?: Array<{ type: string; value?: string[] }> }>>(
    f,
    o.token,
    `/zones/${zone.id}/email/routing/rules?per_page=50`,
  );
  const had = rules.find((r) => r.matchers?.some((m) => m.value?.toLowerCase() === address));
  if (had && !had.actions?.some((a) => a.type === "worker" && a.value?.includes(RELAY_SCRIPT)))
    throw new CloudflareError(
      `${address} already has a routing rule that goes elsewhere. Remove it in Email Routing first, or pick another name.`,
      409,
    );
  const rule =
    had ??
    (await cf<{ id: string }>(f, o.token, `/zones/${zone.id}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "Atlas",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [RELAY_SCRIPT] }],
      }),
    }));
  // Sending.
  let sending_ok = false;
  let sending_note: string | null = null;
  if (o.sending === "cloudflare") {
    try {
      const subs = await cf<Array<{ name: string; enabled: boolean }>>(f, o.token, `/zones/${zone.id}/email/sending/subdomains`);
      if (!subs.some((s) => s.name === mail_domain && s.enabled))
        await cf(f, o.token, `/zones/${zone.id}/email/sending/subdomains`, { method: "POST", body: JSON.stringify({ name: mail_domain }) });
      sending_ok = true;
    } catch (err) {
      sending_note = `${err instanceof Error ? err.message : String(err)}. Cloudflare Email Service needs Workers Paid on the domain's account; Resend's free tier (an extension) is the other way to send.`;
      notes.push(sending_note);
    }
  }
  const mail: AtlasMail = {
    domain,
    mail_domain,
    address,
    zone_id: zone.id,
    account_id: zone.account.id,
    sending: o.sending,
    sending_ok,
    sending_note,
    rule_id: rule.id,
    made_at: atlasMail(sql)?.made_at ?? Date.now(),
  };
  setState(sql, "atlas_mail", mail);
  setSecret(sql, "cf_mail_token", o.token);
  return { mail, notes };
}

/** Takes Atlas's address down: its rule and relay go, and its key and token are forgotten. Routing itself is left as it was. */
export async function removeAtlasMail(sql: Sql, f: typeof fetch): Promise<string[]> {
  const m = atlasMail(sql);
  const token = getSecret<string>(sql, "cf_mail_token");
  const notes: string[] = [];
  if (m && token) {
    if (m.rule_id)
      await cf(f, token, `/zones/${m.zone_id}/email/routing/rules/${m.rule_id}`, { method: "DELETE" }).catch((e: Error) =>
        notes.push(e.message),
      );
    await cf(f, token, `/accounts/${m.account_id}/workers/scripts/${RELAY_SCRIPT}`, { method: "DELETE" }).catch((e: Error) =>
      notes.push(e.message),
    );
  }
  setState(sql, "atlas_mail", null);
  setSecret(sql, "cf_mail_token", null);
  setSecret(sql, "mail_relay", null);
  return notes;
}

/** Sends a whole mail (RFC 5322 text) from Atlas's address with Cloudflare Email Service. */
export async function cloudflareSend(
  sql: Sql,
  f: typeof fetch,
  o: { from: string; recipients: string[]; mime: string },
): Promise<{ message_id?: string }> {
  const m = atlasMail(sql);
  const token = getSecret<string>(sql, "cf_mail_token");
  if (!m || !token) throw new Error("Atlas's own address isn't set up. Settings → Connections → Atlas's email sets it up.");
  const out = await cf<{ delivered?: string[]; queued?: string[]; permanent_bounces?: string[]; message_id?: string }>(
    f,
    token,
    `/accounts/${m.account_id}/email/sending/send_raw`,
    { method: "POST", body: JSON.stringify({ from: o.from, recipients: o.recipients, mime_message: o.mime }) },
  );
  if (out?.permanent_bounces?.length && !out.delivered?.length && !out.queued?.length)
    throw new Error(`Cloudflare couldn't deliver it: ${out.permanent_bounces.join(", ")} bounced.`);
  return out?.message_id ? { message_id: out.message_id } : {};
}
