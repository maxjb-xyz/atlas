// Contacts (VISION §7.1): a contact is a person record with channels (email
// addresses, phone numbers, handles), each with where it came from, and a
// trust level. Atlas recognizes someone across all of their channels: a
// task for Doug, an email from Doug's address and an invite naming him all
// find the same record. Contacts come from the owner's address book (iCloud
// over CardDAV, or a vCard file) and from what comes in: mail from someone
// new makes a record with trust unknown. The owner's own addresses are on
// the owner's record, so they're never someone the owner is "with".

import type { Json, Sql } from "./store/db";
import { type AtlasRecord, correctRecord, createRecord, findRecords, getRecord, ownerRecord, type RecordSource } from "./store/records";
import type { EventPerson } from "./calendar/types";
import type { Card } from "../../extensions/sdk";

export type { Card } from "../../extensions/sdk";

export const CHANNEL_KINDS = ["email", "phone", "telegram", "github", "linear", "handle"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** One way to reach someone, and where Atlas learned it. */
export interface Channel {
  kind: ChannelKind;
  value: string;
  /** Where it came from in plain words: "iCloud contacts", "mail", "you", "Telegram". */
  via: string;
}

export const TRUST = ["family", "friend", "colleague", "client", "unknown"] as const;
export type Trust = (typeof TRUST)[number];

const EMAIL = /[^@\s<>"(),;:]+@[^@\s<>"(),;:]+\.[^@\s<>"(),;:]+/g;

/** A channel's value as it's compared: addresses in lower case, numbers as digits with their +, handles without an @. */
export function normal(kind: ChannelKind, value: string): string {
  const v = value.trim();
  if (kind === "email") return v.toLowerCase().replace(/^mailto:/, "");
  if (kind === "phone") {
    const digits = v.replace(/[^\d+]/g, "");
    // A US number written without its country code is the same as with it.
    if (/^\d{10}$/.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
    return digits;
  }
  return v.toLowerCase().replace(/^@/, "");
}

/** A person's channels: the ones kept as channels, and any email address or phone number in their older details. */
export function channelsOf(r: AtlasRecord): Channel[] {
  const out: Channel[] = [];
  const seen = new Set<string>();
  const add = (c: Channel) => {
    const key = `${c.kind}:${normal(c.kind, c.value)}`;
    if (!c.value.trim() || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const kept = Array.isArray(r.fields.channels) ? r.fields.channels : [];
  for (const c of kept) {
    const o = c as Record<string, unknown> | null;
    if (o && typeof o.value === "string" && CHANNEL_KINDS.includes(o.kind as ChannelKind))
      add({ kind: o.kind as ChannelKind, value: o.value, via: typeof o.via === "string" ? o.via : r.source.via });
  }
  // Details saved by `remember` before contacts had channels: "email", "phone", "github".
  for (const [k, v] of Object.entries(r.fields)) {
    if (k === "channels" || k === "fact") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x !== "string") continue;
      for (const e of x.match(EMAIL) ?? []) add({ kind: "email", value: e, via: r.source.via });
      if (/phone|mobile|cell|tel/i.test(k) && /\d{3}/.test(x)) add({ kind: "phone", value: x, via: r.source.via });
      const handle = (["telegram", "github", "linear"] as const).find((h) => k.toLowerCase().includes(h));
      if (handle && !x.includes("@")) add({ kind: handle, value: x, via: r.source.via });
    }
  }
  return out;
}

export const trustOf = (r: AtlasRecord): Trust => (TRUST.includes(r.fields.trust as Trust) ? (r.fields.trust as Trust) : "unknown");

/** The person with this channel, if Atlas knows one. The owner counts, so their own mail is known as theirs. */
export function findPerson(sql: Sql, kind: ChannelKind, value: string): AtlasRecord | null {
  const want = normal(kind, value);
  if (!want) return null;
  for (const r of findRecords(sql, "person")) {
    if (channelsOf(r).some((c) => c.kind === kind && normal(kind, c.value) === want)) return r;
  }
  // The owner's own addresses from what they connected, before they're on the record.
  if (kind === "email" && ownerAddresses(sql).has(want)) return ownerRecord(sql);
  return null;
}

/** Adds channels to a person, as a correction (History has it, and it can be undone). Returns what was new. */
export function addChannels(
  sql: Sql,
  id: string,
  channels: Channel[],
  source: RecordSource,
  reason = "learned how to reach them",
): Channel[] {
  const r = getRecord(sql, id);
  if (!r) return [];
  const have = channelsOf(r);
  const keys = new Set(have.map((c) => `${c.kind}:${normal(c.kind, c.value)}`));
  const fresh = channels.filter((c) => c.value.trim() && !keys.has(`${c.kind}:${normal(c.kind, c.value)}`));
  if (!fresh.length) return [];
  const kept = [...have, ...fresh].map((c) => ({ kind: c.kind, value: c.value.trim(), via: c.via }));
  correctRecord(sql, id, { fields: { channels: kept as unknown as Json } }, reason, source);
  return fresh;
}

export interface Seen {
  name?: string;
  channels: Channel[];
  trust?: Trust;
  /** Other details worth keeping from an address book: the organization, a birthday, a nickname. */
  details?: Record<string, string>;
}

/**
 * Someone Atlas saw (in the address book, or writing in): the person it
 * already knows by one of their channels, with any new ones added; else a
 * new person record. A name alone never merges two people, since two Sams
 * are common; only a channel does.
 */
export function upsertPerson(
  sql: Sql,
  seen: Seen,
  source: RecordSource,
  o: { confidence?: number } = {},
): { record: AtlasRecord; change: "added" | "merged" | "same" } {
  for (const c of seen.channels) {
    const r = findPerson(sql, c.kind, c.value);
    if (!r) continue;
    const added = addChannels(sql, r.id, seen.channels, source, `learned from ${source.via}`);
    // A better name than an address, and details it didn't have, fill in; nothing the owner said is replaced.
    const patch: Record<string, Json> = {};
    for (const [k, v] of Object.entries(seen.details ?? {})) if (v && r.fields[k] == null) patch[k] = v;
    const better = seen.name && looksLikeAddress(r.name) && !looksLikeAddress(seen.name) ? seen.name : undefined;
    if (Object.keys(patch).length || better)
      correctRecord(sql, r.id, { ...(better ? { name: better } : {}), fields: patch }, `learned from ${source.via}`, source);
    return { record: getRecord(sql, r.id)!, change: added.length || Object.keys(patch).length || better ? "merged" : "same" };
  }
  const name = seen.name?.trim() || seen.channels[0]?.value || "Someone";
  const record = createRecord(sql, {
    type: "person",
    name,
    fields: {
      channels: seen.channels.map((c) => ({ kind: c.kind, value: c.value.trim(), via: c.via })) as unknown as Json,
      trust: seen.trust ?? "unknown",
      ...(seen.details ?? {}),
    },
    source,
    ...(o.confidence != null ? { confidence: o.confidence } : {}),
  });
  return { record, change: "added" };
}

const looksLikeAddress = (s: string) => s.includes("@") || /^\+?\d[\d\s().-]{6,}$/.test(s);

/**
 * The owner's own addresses: the email channels on their record, which the
 * owner adds and extensions fill in when they learn them (the Apple ID that
 * reads the calendar, the Gmail account that's connected).
 */
export function ownerAddresses(sql: Sql): Set<string> {
  const out = new Set<string>();
  const me = sql
    .exec<{ fields: string }>(`SELECT fields FROM records WHERE type = 'person' AND json_extract(fields, '$.is_owner') = 1 LIMIT 1`)
    .toArray()[0];
  if (me) {
    for (const c of (JSON.parse(me.fields) as { channels?: Array<{ kind?: string; value?: string }> }).channels ?? [])
      if (c.kind === "email" && typeof c.value === "string") out.add(normal("email", c.value));
  }
  return out;
}

/** Addresses an extension learned are the owner's (an Apple ID, a Gmail account): on the owner's record, once. */
export function ownerLearned(sql: Sql, emails: string[], via: string): void {
  const fresh = emails.filter((e) => e.includes("@"));
  if (fresh.length)
    addChannels(
      sql,
      ownerRecord(sql).id,
      fresh.map((value) => ({ kind: "email" as const, value, via })),
      { via },
      "your own address",
    );
}

/** An invite's people without the owner, who's on most of their own invites. */
export function othersOf(sql: Sql, people: EventPerson[] | undefined): EventPerson[] | undefined {
  if (!people?.length) return people;
  const mine = ownerAddresses(sql);
  if (!mine.size) return people;
  const rest = people.filter((p) => !(p.email && mine.has(normal("email", p.email))));
  return rest.length ? rest : undefined;
}

/** Every address in a line like "Doug Henderson <doug@acme.com>". */
export const addressesIn = (line: string): string[] => (line.match(EMAIL) ?? []).map((e) => e.toLowerCase());

/** "Doug Henderson <doug@acme.com>" as a name and an address. */
export function splitAddress(line: string): { name: string; email: string } | null {
  const email = addressesIn(line)[0];
  if (!email) return null;
  const name = line
    .replace(/<[^>]*>/, "")
    .replace(EMAIL, "")
    .replace(/["']/g, "")
    .trim();
  return { name, email };
}

// --- vCards (RFC 6350), from a file or iCloud ------------------------------------------------------------

const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** The contacts in a vCard file (any version): names, addresses, numbers, handles, and a few details. */
export function parseVCards(text: string): Card[] {
  // Folded lines continue with a space or a tab.
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const out: Card[] = [];
  let card: Card | null = null;
  let n = "";
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^BEGIN:VCARD$/i.test(line)) {
      card = { name: "", emails: [], phones: [], handles: [], details: {} };
      n = "";
      continue;
    }
    if (!card) continue;
    if (/^END:VCARD$/i.test(line)) {
      if (!card.name && n) card.name = n;
      if (!card.name) card.name = card.emails[0] ?? card.phones[0] ?? "";
      if (card.name && (card.emails.length || card.phones.length || card.handles.length || card.name)) out.push(card);
      card = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // "item1.EMAIL;type=INTERNET" is EMAIL with its parameters.
    const [prop = "", ...params] = head.replace(/^[\w-]+\./, "").split(";");
    const p = prop.toUpperCase();
    const param = params.join(";").toLowerCase();
    if (p === "FN") card.name = unescape(value).trim();
    else if (p === "N") {
      const [family = "", given = ""] = value.split(";").map(unescape);
      n = `${given} ${family}`.trim();
    } else if (p === "EMAIL" && value.includes("@")) card.emails.push(value.replace(/^mailto:/i, "").trim());
    else if (p === "TEL" && /\d/.test(value)) card.phones.push(value.replace(/^tel:/i, "").trim());
    else if (p === "NICKNAME" && value.trim()) card.details.nickname = unescape(value).trim();
    else if (p === "ORG" && value.trim()) card.details.organization = unescape(value).split(";")[0]!.trim();
    else if (p === "TITLE" && value.trim()) card.details.title = unescape(value).trim();
    else if (p === "BDAY" && value.trim()) card.details.birthday = value.trim();
    else if (p === "X-SOCIALPROFILE" || p === "IMPP" || p === "URL") {
      const v = value.trim();
      const kind: ChannelKind | null = /telegram|t\.me/i.test(param + v)
        ? "telegram"
        : /github/i.test(param + v)
          ? "github"
          : /linear/i.test(param + v)
            ? "linear"
            : null;
      if (kind) {
        const handle = v.replace(/^.*(?:t\.me|github\.com|linear\.app)\//i, "").replace(/^(?:x-apple:|telegram:)/i, "");
        if (handle) card.handles.push({ kind, value: handle.replace(/\/$/, "") });
      }
    }
  }
  return out;
}

/** A card as a person Atlas saw, from the address book. */
export function cardSeen(c: Card, via: string): Seen {
  return {
    name: c.name,
    channels: [
      ...c.emails.map((value) => ({ kind: "email" as const, value, via })),
      ...c.phones.map((value) => ({ kind: "phone" as const, value, via })),
      ...c.handles.map((h) => ({ kind: h.kind, value: h.value, via })),
    ],
    details: c.details,
  };
}

/**
 * Brings the owner's address book in: each card merged with the person
 * Atlas already knows by a channel, or added. Cards with no way to reach
 * anyone are left out. History has each change and a line for the import.
 */
export function importCards(sql: Sql, cards: Card[], via: string): { added: number; merged: number; same: number; skipped: number } {
  const out = { added: 0, merged: 0, same: 0, skipped: 0 };
  const mine = ownerAddresses(sql);
  for (const c of cards.slice(0, 5_000)) {
    const seen = cardSeen(c, via);
    // The owner's own card goes on the owner's record.
    if (c.emails.some((e) => mine.has(normal("email", e)))) {
      addChannels(sql, ownerRecord(sql).id, seen.channels, { via }, "your own card");
      out.same += 1;
      continue;
    }
    if (!seen.channels.length) {
      out.skipped += 1;
      continue;
    }
    const r = upsertPerson(sql, seen, { via });
    out[r.change] += 1;
  }
  return out;
}
