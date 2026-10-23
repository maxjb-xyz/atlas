// Gmail (VISION §10.1, §16.2): the owner's inbox as a sense, and mail sent
// as the owner. The owner makes a Google sign-in for Atlas once (their own
// OAuth client); the core runs the sign-in and keeps the token fresh. A look
// on the clock asks Gmail's history what's new since the last history id,
// so nothing is missed across a deploy and nothing comes twice. Each new
// message in the inbox is an item, with its words kept aside as raw content
// for the quarantined reader; the owner's own sent mail isn't news, but the
// threads they wrote on are remembered, so a reply in one is marked as one.

import { type Extension, type Item, type Json, get, http, json, tidy } from "../sdk";
import { base64url, buildMail, decodeWords, fromBase64url, htmlText } from "../lib/mail";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** At most this many new messages are read in one look; the rest are counted, not read. */
const MAX_PER_LOOK = 25;
/** Threads the owner wrote on, remembered so a reply in one is marked as one. */
const MAX_SENT = 300;

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: Part[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}
interface State {
  /** The connected account's address. */
  email?: string;
  sent?: string[];
}

const auth = (ctx: { secret(n: string): string }) => ({ authorization: `Bearer ${ctx.secret("access_token")}` });
const header = (m: GMessage, name: string) =>
  decodeWords(m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "").trim();
const addresses = (line: string) => (line.match(/[^\s<>",;:()]+@[^\s<>",;:()]+\.[^\s<>",;:()]+/g) ?? []).map((a) => a.toLowerCase());

/** The readable text of a message: its plain-text part, or its HTML part as text. */
export function bodyText(p: Part | undefined): string {
  if (!p) return "";
  const decode = (d?: string) => (d ? new TextDecoder().decode(fromBase64url(d)) : "");
  const all: Part[] = [];
  const walk = (x: Part) => {
    all.push(x);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  const plain = all.find((x) => x.mimeType === "text/plain" && !x.filename && x.body?.data);
  if (plain) return decode(plain.body!.data).trim();
  const html = all.find((x) => x.mimeType === "text/html" && !x.filename && x.body?.data);
  return html ? htmlText(decode(html.body!.data)) : "";
}

/** A message in the inbox as an item for the intake. */
export function itemOf(m: GMessage, st: State): Item {
  const from = header(m, "From");
  const subject = header(m, "Subject") || "(no subject)";
  const own = st.email?.toLowerCase();
  const people = [...new Set([...addresses(header(m, "To")), ...addresses(header(m, "Cc"))])].filter((a) => a !== own);
  const labels = m.labelIds ?? [];
  const category = labels.find((l) => l.startsWith("CATEGORY_") && l !== "CATEGORY_PERSONAL");
  const bulk = !!header(m, "List-Unsubscribe") || !!header(m, "List-Id") || /^(bulk|list|junk)$/i.test(header(m, "Precedence"));
  const automated = /^auto-/i.test(header(m, "Auto-Submitted"));
  const reply = (st.sent ?? []).includes(m.threadId);
  const signals = [
    ...(category ? [category.slice(9).toLowerCase()] : []),
    ...(bulk ? ["newsletter"] : []),
    ...(automated ? ["automated"] : []),
    ...(labels.includes("IMPORTANT") ? ["important"] : []),
    ...(reply ? ["reply"] : []),
    ...(people.length > 1 ? ["group"] : []),
  ];
  const name = from.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || from;
  const body = bodyText(m.payload) || m.snippet || "";
  return {
    event: reply ? "reply" : "received",
    what: `Mail from ${tidy(name, 80)}${reply ? ", replying in a thread you wrote on" : ""}: "${tidy(subject, 160)}"`,
    key: m.id,
    thread: `gmail:${m.threadId}`,
    from,
    ...(people.length ? { people } : {}),
    signals,
    link: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
    subject: tidy(subject, 200),
    ...(header(m, "Message-ID") ? { message_id: header(m, "Message-ID") } : {}),
    ...(header(m, "References") ? { references: header(m, "References") } : {}),
    raw: [
      `From: ${from}`,
      `To: ${header(m, "To")}`,
      ...(header(m, "Cc") ? [`Cc: ${header(m, "Cc")}`] : []),
      `Subject: ${subject}`,
      `Date: ${header(m, "Date")}`,
      "",
      body,
    ]
      .join("\n")
      .slice(0, 20_000),
  };
}

async function message(ctx: { secret(n: string): string }, id: string, format: "full" | "metadata" = "full"): Promise<GMessage | null> {
  const res = await get(`${API}/messages/${id}?format=${format}`, { headers: auth(ctx) });
  // Deleted between the history and the read: nothing to tell.
  if (res.status === 404) return null;
  return json<GMessage>(res, "Gmail");
}

async function profile(ctx: { secret(n: string): string }) {
  return json<{ emailAddress: string; historyId: string; messagesTotal?: number }>(
    await get(`${API}/profile`, { headers: auth(ctx) }),
    "Gmail",
  );
}

const ext: Extension = {
  manifest: {
    id: "gmail",
    name: "Gmail",
    version: "1.0.0",
    about:
      "Your Gmail inbox as something Atlas notices (new mail, replies you're waiting for), and mail sent as you, only after you say yes. Atlas reads mail and sends; it doesn't delete or archive.",
    provides: ["mail", "sense"],
    hosts: ["gmail.googleapis.com"],
    signin: {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
      params: { access_type: "offline", prompt: "consent" },
      help: [
        "Atlas signs in to Gmail with a Google sign-in of your own, so your mail goes from Google to your Atlas and nowhere else.",
        "1. At console.cloud.google.com, make a project (any name), then APIs & Services → Library → Gmail API → Enable.",
        "2. APIs & Services → OAuth consent screen: External, your own email as the contact, and add yourself as a test user. Then Publish app, so it's In production: a sign-in left in Testing stops working after seven days. Google will say it's unverified; that's expected for an app only you use.",
        "3. APIs & Services → Credentials → Create credentials → OAuth client ID → Web application, with the redirect address below as an authorized redirect URI.",
        "4. Paste its client ID and secret here, then sign in with Google.",
      ].join("\n"),
    },
    every: 2,
    look_needs: ["access_token"],
  },
  async look(ctx) {
    const st = (ctx.state ?? {}) as State;
    const cursor = (ctx.cursor ?? null) as { history?: string } | null;
    // The first look starts from now: what was already in the inbox isn't news.
    if (!cursor?.history) {
      const p = await profile(ctx);
      return { items: [], cursor: { history: p.historyId }, state: { ...st, email: p.emailAddress.toLowerCase() } as Json };
    }
    const added: Array<{ id: string; threadId: string; labelIds?: string[] }> = [];
    let page: string | undefined;
    let latest = cursor.history;
    for (let i = 0; i < 5; i++) {
      const res = await get(
        `${API}/history?startHistoryId=${encodeURIComponent(cursor.history)}&historyTypes=messageAdded&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
        { headers: auth(ctx) },
      );
      // Gmail keeps about a week of history: older than that, start again from now.
      if (res.status === 404) {
        const p = await profile(ctx);
        return { items: [], cursor: { history: p.historyId }, state: st as Json };
      }
      const h = await json<{
        history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>;
        historyId: string;
        nextPageToken?: string;
      }>(res, "Gmail");
      for (const e of h.history ?? []) for (const a of e.messagesAdded ?? []) added.push(a.message);
      latest = h.historyId;
      page = h.nextPageToken;
      if (!page) break;
    }
    const seen = new Set<string>();
    const fresh = added.filter((m) => !seen.has(m.id) && seen.add(m.id) && !(m.labelIds ?? []).includes("DRAFT"));
    // What the owner sent: their threads, so a reply is known as one.
    const sentThreads = fresh.filter((m) => (m.labelIds ?? []).includes("SENT")).map((m) => m.threadId);
    const sent = [...new Set([...sentThreads, ...(st.sent ?? [])])].slice(0, MAX_SENT);
    const next: State = { ...st, sent };
    const inbox = fresh.filter((m) => (m.labelIds ?? []).includes("INBOX") && !(m.labelIds ?? []).includes("SENT")).slice(-MAX_PER_LOOK);
    const items: Item[] = [];
    for (const a of inbox) {
      const m = await message(ctx, a.id);
      if (m) items.push(itemOf(m, next));
    }
    return { items, cursor: { history: latest }, state: next as Json };
  },
  async mail(ctx, m) {
    const st = (ctx.state ?? {}) as State;
    const email = st.email ?? (await profile(ctx)).emailAddress.toLowerCase();
    const built = buildMail({
      from: { address: email, ...(m.from?.name ? { name: m.from.name } : {}) },
      to: m.to,
      ...(m.cc?.length ? { cc: m.cc } : {}),
      subject: m.subject,
      text: m.text,
      ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
      ...(m.references?.length ? { references: m.references } : {}),
    });
    const thread = m.thread?.replace(/^gmail:/, "");
    const res = await http(`${API}/messages/send`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ raw: base64url(new TextEncoder().encode(built.text)), ...(thread ? { threadId: thread } : {}) }),
    });
    const sentMsg = await json<{ id: string; threadId: string }>(res, "Gmail");
    return {
      id: sentMsg.id,
      thread: `gmail:${sentMsg.threadId}`,
      link: `https://mail.google.com/mail/u/0/#sent/${sentMsg.threadId}`,
      message_id: built.message_id,
      state: {
        ...st,
        email,
        sent: [sentMsg.threadId, ...(st.sent ?? []).filter((t) => t !== sentMsg.threadId)].slice(0, MAX_SENT),
      } as Json,
    };
  },
  async test(ctx) {
    const p = await profile(ctx);
    const list = await json<{ messages?: Array<{ id: string }> }>(
      await get(`${API}/messages?maxResults=1&labelIds=INBOX`, { headers: auth(ctx) }),
      "Gmail",
    );
    const newest = list.messages?.[0] ? await message(ctx, list.messages[0].id, "metadata") : null;
    const subject = newest ? header(newest, "Subject") || "(no subject)" : null;
    return {
      text: `Gmail connected as ${p.emailAddress}.${subject ? ` The newest message in the inbox is "${tidy(subject, 120)}".` : " The inbox is empty."}`,
      owner: { emails: [p.emailAddress.toLowerCase()] },
      state: { ...((ctx.state ?? {}) as State), email: p.emailAddress.toLowerCase() } as Json,
    };
  },
};

export default ext;
