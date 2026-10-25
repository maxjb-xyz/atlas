// Contacts' photos (docs/ui §8: people with a photo in the address book
// show it). The address book's photo of a person is kept in R2 under
// photos/, apart from the owner's files, and what it is and where it came
// from is in the state table, so records stay small and the model never
// reads it. The app loads it from /api/photos/<record id>, with the owner's
// session. A photo is taken again only when its address book's copy changes.

import type { Sql } from "./store/db";
import { getState, setState } from "./store/state";

/** A contact photo is a thumbnail; anything bigger than this isn't kept. */
export const MAX_PHOTO_BYTES = 1_000_000;

/** What's kept for a person's photo: its type, a short version for the app's cache, and where it came from. */
export interface KeptPhoto {
  type: string;
  v: string;
  /** The address it was read from, or the hash of the image when the card carried it. */
  src: string;
  at: number;
}

const stateKey = (id: string) => `photo:${id}` as const;
export const photoKey = (id: string) => `photos/${id}`;

export const keptPhoto = (sql: Sql, id: string): KeptPhoto | null => getState<KeptPhoto>(sql, stateKey(id));

/** Where the app loads a person's photo, when there is one. */
export function photoUrl(sql: Sql, id: string): string | undefined {
  const k = keptPhoto(sql, id);
  return k ? `/api/photos/${encodeURIComponent(id)}?v=${k.v}` : undefined;
}

/** The image's type, read from its first bytes rather than from what it says it is, so only a real image is served. */
export function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Bytes from base64 (any line breaks or spaces in it are dropped), or null when it isn't base64. */
export function fromBase64(b64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A data: URL's image bytes, or null for anything else. */
export function fromDataUrl(s: string): Uint8Array | null {
  const m = /^data:image\/[\w.+-]+(?:;[^,]*)?;base64,(.*)$/is.exec(s.trim());
  return m ? fromBase64(m[1]!) : null;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** Where a card's photo comes from, to tell whether it changed: an https address as it is, an image by its hash. */
export async function photoSource(photo: string): Promise<string> {
  return /^https:\/\//i.test(photo) ? photo : `sha256:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(photo)))}`;
}

/**
 * Keeps a person's photo. Says why when it isn't kept: not an image, too
 * big, or R2 wouldn't take it (in R2's own words).
 */
export async function keepPhoto(sql: Sql, bucket: R2Bucket, id: string, bytes: Uint8Array, src: string): Promise<void> {
  const type = imageType(bytes);
  if (!type) throw new Error("it isn't a JPEG, PNG, GIF or WebP image");
  if (bytes.byteLength > MAX_PHOTO_BYTES)
    throw new Error(`it's ${Math.round(bytes.byteLength / 1000)} KB, and a contact's photo can be at most ${MAX_PHOTO_BYTES / 1e6} MB`);
  try {
    await bucket.put(photoKey(id), bytes, { httpMetadata: { contentType: type } });
  } catch (err) {
    throw new Error(`R2 wouldn't keep it: ${err instanceof Error ? err.message : String(err)}`);
  }
  const v = hex(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 12);
  setState(sql, stateKey(id), { type, v, src, at: Date.now() } satisfies KeptPhoto);
}
