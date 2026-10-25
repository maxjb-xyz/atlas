// Google contacts (VISION §7.1) through the People API: the owner's own
// contacts ("My contacts") as cards, each with the address of its photo when
// they gave it one (not Google's lettered default). The photo itself is read
// only when the core asks for it, from Google's image host.

import { type Card, Failure, get, json, tidy } from "../sdk";

const PEOPLE = "https://people.googleapis.com/v1/people/me/connections";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations,birthdays,nicknames,photos";
/** As many as the core takes from one address book. */
const MAX = 5_000;

export interface GPerson {
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  birthdays?: Array<{ date?: { year?: number; month?: number; day?: number }; text?: string }>;
  nicknames?: Array<{ value?: string }>;
  photos?: Array<{ url?: string; default?: boolean; metadata?: { primary?: boolean } }>;
}

const two = (n: number) => String(n).padStart(2, "0");

/** One of Google's people as a card, or null when it has no name and no way to reach them. */
export function cardOf(p: GPerson): Card | null {
  const emails = (p.emailAddresses ?? []).map((e) => e.value?.trim() ?? "").filter((e) => e.includes("@"));
  const phones = (p.phoneNumbers ?? []).map((t) => t.value?.trim() ?? "").filter((t) => /\d/.test(t));
  const name = p.names?.find((n) => n.displayName?.trim())?.displayName?.trim() || emails[0] || phones[0] || "";
  if (!name) return null;
  const details: Record<string, string> = {};
  const org = p.organizations?.[0];
  if (org?.name?.trim()) details.organization = org.name.trim();
  if (org?.title?.trim()) details.title = org.title.trim();
  const nick = p.nicknames?.find((n) => n.value?.trim())?.value?.trim();
  if (nick) details.nickname = nick;
  const b = p.birthdays?.find((x) => x.date?.month && x.date?.day) ?? p.birthdays?.find((x) => x.text?.trim());
  if (b?.date?.month && b.date.day) details.birthday = `${b.date.year ? b.date.year : "-"}-${two(b.date.month)}-${two(b.date.day)}`;
  else if (b?.text?.trim()) details.birthday = b.text.trim();
  const photos = (p.photos ?? []).filter((x) => x.url && !x.default);
  const photo = (photos.find((x) => x.metadata?.primary) ?? photos[0])?.url;
  return { name, emails, phones, handles: [], details, ...(photo ? { photo } : {}) };
}

/** Every one of the owner's Google contacts, a thousand a page. */
export async function googleCards(headers: Record<string, string>): Promise<Card[]> {
  const out: Card[] = [];
  let page = "";
  do {
    const url = `${PEOPLE}?personFields=${FIELDS}&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
    const res = await get(url, { headers }, "Google contacts");
    // A sign-in from before contacts were asked for, or the People API not turned on, both come back 403.
    if (res.status === 403)
      throw new Failure(
        `Google contacts (people.googleapis.com) answered 403: ${tidy(await res.text(), 300)} Atlas needs the People API turned on in your Google Cloud project, and a Google sign-in that allows contacts: turn it on, then sign in with Google again.`,
        "auth",
        403,
      );
    const got = await json<{ connections?: GPerson[]; nextPageToken?: string }>(res, "Google contacts");
    for (const p of got.connections ?? []) {
      const c = cardOf(p);
      if (c) out.push(c);
    }
    page = got.nextPageToken ?? "";
  } while (page && out.length < MAX);
  return out;
}
