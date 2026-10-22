// The vault (§15): logins, cards, two-factor seeds and keys, stored by name
// and tied to the sites they belong to. The model only ever sees names and
// sites. A value is filled in at the last step, into a browser field, by
// the outbox; Atlas gets back "filled 2 fields on chase.com". The first use
// on each site asks, a card asks every time, and every use is a receipt.
// Every value is registered with the scrubber, so nothing that leaves
// Atlas, and no page Atlas reads back, can carry one.
//
// Values are kept with the other secrets in the agent's own storage, which
// Cloudflare encrypts at rest. 1Password and Bitwarden come later.

import { newId, type Sql } from "./store/db";
import { getSecret, setSecret } from "./store/settings";

import { FIELDS, type VaultKind, type VaultView } from "./vault-fields";

export { FIELDS, type VaultKind, type VaultView };

export interface VaultEntry {
  id: string;
  name: string;
  kind: VaultKind;
  /** Hostnames it fills on: "chase.com" also covers "secure.chase.com". */
  sites: string[];
  values: Record<string, string>;
  /** A two-factor seed (base32), for logins: the code is made in the vault, when it's filled. */
  totp?: string;
  /** Sites the owner has said yes to, so it fills there without asking (a card always asks). */
  allowed: string[];
  uses: number;
  last_used: number | null;
  created_at: number;
}

export const vault = (sql: Sql): VaultEntry[] => getSecret<VaultEntry[]>(sql, "vault") ?? [];

export const vaultView = (e: VaultEntry): VaultView => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  sites: e.sites,
  fields: Object.keys(e.values).filter((k) => e.values[k]),
  totp: Boolean(e.totp),
  allowed: e.allowed,
  uses: e.uses,
  last_used: e.last_used,
});

/** Turns "https://www.Chase.com/login" or "chase.com" into "chase.com". */
export function siteOf(s: string): string {
  const t = s.trim().toLowerCase();
  try {
    return new URL(/^[a-z]+:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch {
    return t.replace(/^www\./, "");
  }
}

/** Whether an entry belongs on this host: the site itself, or a subdomain of it. */
export const fillsOn = (e: Pick<VaultEntry, "sites">, host: string) => {
  const h = siteOf(host);
  return e.sites.some((s) => h === s || h.endsWith(`.${s}`));
};

/** The site of `host` that an entry was tied to, for remembering the owner's yes. */
export const siteFor = (e: Pick<VaultEntry, "sites">, host: string) => {
  const h = siteOf(host);
  return e.sites.find((s) => h === s || h.endsWith(`.${s}`)) ?? h;
};

export function findEntry(sql: Sql, nameOrId: string): VaultEntry | null {
  const want = nameOrId.trim().toLowerCase();
  return vault(sql).find((e) => e.id === nameOrId || e.name.toLowerCase() === want) ?? null;
}

/** Adds an entry, or changes one. An empty value on a change keeps what was there. */
export function saveEntry(
  sql: Sql,
  e: { id?: string; name: string; kind: VaultKind; sites: string[]; values: Record<string, string>; totp?: string | null },
): VaultEntry {
  const all = vault(sql);
  const old = e.id ? all.find((x) => x.id === e.id) : undefined;
  if (e.id && !old) throw new Error("That vault entry isn't there any more.");
  const name = e.name.trim();
  if (!name) throw new Error("A vault entry needs a name.");
  if (all.some((x) => x.id !== old?.id && x.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`There's already one called ${name}.`);
  const sites = [...new Set(e.sites.map(siteOf).filter(Boolean))];
  if (!sites.length) throw new Error("Tie it to at least one site, like chase.com: it only fills there.");
  const values: Record<string, string> = {};
  for (const k of Object.keys(FIELDS[e.kind])) {
    if (k === "code") continue;
    const v = e.values[k]?.trim() ?? "";
    if (v) values[k] = v;
    else if (old?.values[k] && old.kind === e.kind) values[k] = old.values[k]!;
  }
  if (!Object.keys(values).length) throw new Error("Fill in at least one value.");
  const seed = e.totp === null ? undefined : e.totp?.replace(/\s+/g, "").toUpperCase() || old?.totp;
  if (seed && !/^[A-Z2-7]+=*$/.test(seed))
    throw new Error("The two-factor seed should be the letters and digits the site showed (base32).");
  const entry: VaultEntry = {
    id: old?.id ?? newId("vlt"),
    name,
    kind: e.kind,
    sites,
    values,
    ...(e.kind === "login" && seed ? { totp: seed } : {}),
    // Moving an entry to other sites drops the yes for sites it no longer fills on.
    allowed: (old?.allowed ?? []).filter((s) => sites.some((x) => s === x || s.endsWith(`.${x}`))),
    uses: old?.uses ?? 0,
    last_used: old?.last_used ?? null,
    created_at: old?.created_at ?? Date.now(),
  };
  setSecret(sql, "vault", [...all.filter((x) => x.id !== entry.id), entry]);
  return entry;
}

export function removeEntry(sql: Sql, id: string): VaultEntry | null {
  const all = vault(sql);
  const gone = all.find((x) => x.id === id) ?? null;
  setSecret(
    sql,
    "vault",
    all.filter((x) => x.id !== id),
  );
  return gone;
}

/** Changes one entry in place: a use counted, a site allowed or taken back. */
export function touchEntry(sql: Sql, id: string, change: (e: VaultEntry) => VaultEntry): VaultEntry | null {
  const all = vault(sql);
  const i = all.findIndex((x) => x.id === id);
  if (i < 0) return null;
  all[i] = change(all[i]!);
  setSecret(sql, "vault", all);
  return all[i]!;
}

/**
 * Every value in the vault, usernames and names on cards included, so a
 * page Atlas reads back can't show it one (§15: the model never sees the
 * values). Only the secret ones are kept out of what leaves Atlas
 * (`secretValues`), so Atlas can still say the owner's own name.
 */
export function hiddenValues(sql: Sql): string[] {
  const out: string[] = [];
  for (const e of vault(sql)) {
    for (const v of Object.values(e.values)) if (v.length >= 3) out.push(v);
    if (e.totp && e.totp.length >= 8) out.push(e.totp);
  }
  return out.sort((a, b) => b.length - a.length);
}

// --- two-factor codes (RFC 6238), made inside the vault ---------------------------------------

function base32(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "")) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error("The two-factor seed isn't base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The six-digit code for a seed at a moment (30-second steps, SHA-1, as authenticator apps make them). */
export async function totp(seed: string, at = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32(seed), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(at / 30_000)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const o = mac[mac.length - 1]! & 0x0f;
  const n = (((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** The value for one field of an entry, the code made now. */
export async function valueOf(e: VaultEntry, field: string): Promise<string | null> {
  if (field === "code") return e.totp ? totp(e.totp) : null;
  return e.values[field] ?? null;
}
