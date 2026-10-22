// Push notifications to the owner's devices (§14), by the Web Push standard:
// the payload is encrypted for the device (RFC 8291, aes128gcm) and the
// request is signed with this deployment's own key (VAPID, RFC 8292). Only
// WebCrypto, so nothing is added to the Worker.

import { type Sql } from "./store/db";
import { getSecret, setSecret } from "./store/settings";

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** The public key, uncompressed and base64url, as the browser's applicationServerKey. */
  public: string;
  private_jwk: JsonWebKey;
}

const enc = new TextEncoder();

export const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** This deployment's VAPID keys, made on first use and kept with the secrets. */
export async function vapidKeys(sql: Sql): Promise<VapidKeys> {
  const stored = getSecret<VapidKeys>(sql, "push_vapid");
  if (stored?.public && stored.private_jwk) return stored;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const keys: VapidKeys = {
    public: b64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    private_jwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
  setSecret(sql, "push_vapid", keys);
  return keys;
}

/** The Authorization header for one push service: a short-lived JWT signed with the VAPID key. */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.private_jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is r || s, which is what a JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.public}`;
}

/** Encrypts a payload for one subscription: one aes128gcm record (RFC 8291 §3, RFC 8188). */
export async function encryptPayload(payload: Uint8Array, sub: PushSubscriptionJSON): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The standard's field is `public`; the Workers types spell it `$public`, and the runtime takes `public`.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the delimiter that marks the last record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

export interface PushOutcome {
  ok: boolean;
  status: number;
  /** The push service says this subscription is gone for good (404 or 410): stop using it. */
  gone: boolean;
  /** What went wrong, with the status, the host and the push service's own words. */
  error?: string;
}

/** Sends one notification. Never throws: a failure comes back explained. */
export async function sendPush(
  f: typeof fetch,
  sub: PushSubscriptionJSON,
  payload: object,
  o: { keys: VapidKeys; subject: string; urgency: "high" | "normal"; ttl: number },
): Promise<PushOutcome> {
  let host = "the push service";
  try {
    host = new URL(sub.endpoint).host;
    const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub);
    const res = await f(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuth(sub.endpoint, o.keys, o.subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(o.ttl),
        urgency: o.urgency,
      },
      body,
    });
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const words = (await res.text().catch(() => "")).trim().slice(0, 300);
    return {
      ok: false,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: `${host} answered ${res.status}${words ? `: ${words}` : ""}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
