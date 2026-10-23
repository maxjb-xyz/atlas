// Mail as text (RFC 5322 and MIME), for the extensions that read and send
// it: headers read and written, words encoded when they aren't plain ASCII,
// and a message built for sending.

import { base64 } from "../sdk";

/** A header's value with RFC 2047 encoded words decoded ("=?UTF-8?B?...?="). */
export function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=\s*(?==\?)|=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (...m: string[]) => {
    const charset = m[1] ?? m[4] ?? "utf-8";
    const enc = (m[2] ?? m[5] ?? "B").toUpperCase();
    const text = m[3] ?? m[6] ?? "";
    try {
      const bytes =
        enc === "B"
          ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
          : Uint8Array.from(
              text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c) => c.charCodeAt(0),
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return text;
    }
  });
}

/** A header value as an encoded word when it isn't plain ASCII. */
export function encodeWord(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${base64(new TextEncoder().encode(v))}?=`;
}

/** "Name <a@b.c>" with the name encoded when it needs to be. */
export function addressLine(a: { address: string; name?: string }): string {
  if (!a.name) return a.address;
  const name = /^[\w .'-]*$/.test(a.name) ? (/[.']/.test(a.name) ? `"${a.name}"` : a.name) : encodeWord(a.name);
  return `${name} <${a.address}>`;
}

/** The text of an HTML body, near enough to read: tags dropped, entities for the common characters decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

export interface Outgoing {
  from: { address: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  in_reply_to?: string;
  references?: string[];
  /** Extra headers, such as Auto-Submitted. */
  headers?: Record<string, string>;
  /** A Message-ID to use; made from the sender's domain when not given. */
  message_id?: string;
}

/** A plain-text mail as RFC 5322 text, its body in base64 so any language survives. */
export function buildMail(m: Outgoing, now = Date.now()): { text: string; message_id: string } {
  // A line break in a header would start another one (a hidden Bcc, a new body): nothing with one goes out.
  const plain = [
    m.from.address,
    ...m.to,
    ...(m.cc ?? []),
    m.in_reply_to ?? "",
    ...(m.references ?? []),
    m.message_id ?? "",
    ...Object.entries(m.headers ?? {}).flat(),
  ];
  if (plain.some((v) => /[\r\n]/.test(v))) throw new Error("A mail header held a line break, so the mail wasn't built.");
  const domain = m.from.address.split("@")[1] ?? "atlas.invalid";
  const message_id = m.message_id ?? `<${crypto.randomUUID()}@${domain}>`;
  const refs = [...new Set([...(m.references ?? []), ...(m.in_reply_to ? [m.in_reply_to] : [])])];
  const lines = [
    `From: ${addressLine(m.from)}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${new Date(now).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${message_id}`,
    ...(m.in_reply_to ? [`In-Reply-To: ${m.in_reply_to}`] : []),
    ...(refs.length ? [`References: ${refs.join(" ")}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (base64(new TextEncoder().encode(m.text)).match(/.{1,76}/g) ?? [""]).join("\r\n"),
  ];
  return { text: lines.join("\r\n"), message_id };
}

/** Base64url without padding, as Gmail's API takes a raw message. */
export const base64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Bytes from base64url, as Gmail's API returns a body. */
export function fromBase64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  return Uint8Array.from(atob(b + pad), (c) => c.charCodeAt(0));
}
