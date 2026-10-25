// Atlas's own encryption of what it keeps secret (VISION §20): the vault,
// and every key and token in the secrets table. Cloudflare already encrypts
// storage at rest, with keys Cloudflare holds; this adds a key Atlas holds,
// kept as the Worker secret ATLAS_DATA_KEY, so a leaked copy of storage, a
// backup or an export doesn't carry the values. It doesn't hide them from
// Cloudflare itself: the running code has the key (the docs say so plainly).
//
// XChaCha20-Poly1305 (@noble/ciphers, audited, synchronous, so the secrets
// table keeps its synchronous reads), with a key derived from the secret by
// HKDF-SHA256, a random nonce per value, and the secret's name as associated
// data, so a sealed value can't be moved under another name.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Sealed values start with this, so values kept before sealing are still read. */
const PREFIX = "enc1:";
/** A key shorter than this is refused: it could be guessed. */
export const MIN_DATA_KEY = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

let key: Uint8Array | null = null;
let state: DataKeyState = "missing";
/** The last value that couldn't be opened, for Settings: which secret, and why. */
let unreadable: string | null = null;

export type DataKeyState = "on" | "missing" | "short";

/**
 * Takes this deployment's key, from the ATLAS_DATA_KEY secret. Every agent
 * in the isolate shares it; the same secret always gives the same key.
 */
export function useDataKey(secret: string | undefined): void {
  if (!secret) {
    key = null;
    state = "missing";
  } else if (secret.length < MIN_DATA_KEY) {
    key = null;
    state = "short";
  } else {
    key = hkdf(sha256, enc.encode(secret), enc.encode("atlas"), enc.encode("atlas secrets v1"), 32);
    state = "on";
  }
}

/** Whether values are sealed, and if one couldn't be opened, which and why: for Settings → Account. */
export function dataKeyView(): { state: DataKeyState; unreadable: string | null } {
  return { state, unreadable };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Seals a value kept under `name`. With no key, it's kept as it is, and Settings says so. */
export function seal(name: string, value: string): string {
  if (!key) return value;
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const box = xchacha20poly1305(key, nonce, enc.encode(name)).encrypt(enc.encode(value));
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return PREFIX + b64(out);
}

export const isSealed = (stored: string) => stored.startsWith(PREFIX);

/**
 * Opens a value kept under `name`. One kept before sealing comes back as it
 * is. One that can't be opened (no key, or a different key from the one that
 * sealed it) gives null, and Settings → Account says which and why, so one
 * bad value never stops the agent from starting.
 */
export function open(name: string, stored: string): string | null {
  if (!isSealed(stored)) return stored;
  if (!key) {
    unreadable = `${name}: it was sealed with ATLAS_DATA_KEY, and this deployment has none. Set the same key again.`;
    console.error(JSON.stringify({ at: "sealed.open", name, error: "no key" }));
    return null;
  }
  try {
    const all = unb64(stored.slice(PREFIX.length));
    return dec.decode(xchacha20poly1305(key, all.slice(0, 24), enc.encode(name)).decrypt(all.slice(24)));
  } catch (err) {
    unreadable = `${name}: it doesn't open with this deployment's ATLAS_DATA_KEY, so the key was changed. Put the old key back.`;
    console.error(JSON.stringify({ at: "sealed.open", name, error: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

/** Forgets the last failure, once the values open again (after the key is put back). */
export function clearUnreadable(): void {
  unreadable = null;
}
