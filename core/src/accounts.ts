// Accounts (VISION §6.2, §17): when the owner has more than one mail or
// calendar account, which one Atlas uses. A reply goes from the account its
// mail came in on; anything new goes from the account the area names, else
// the owner's default, else the first; new events the same way. Calendars
// are all read together. The model is told the accounts, and can pick one
// when the owner says to.

import { type Area, listAreas } from "./store/areas";
import { accountName, type Installed, methodsOf, providing, ready } from "./extensions";
import type { Sql } from "./store/db";
import { readSettings } from "./store/settings";

/** The owner's mail accounts that can send (signed in), oldest first. */
export const mailAccounts = (sql: Sql): Installed[] => providing(sql, "mail").filter((e) => methodsOf(e).includes("mail") && ready(sql, e));
/** The owner's calendars, oldest first. */
export const calendarAccounts = (sql: Sql): Installed[] =>
  providing(sql, "calendar").filter((e) => methodsOf(e).includes("calendar") && ready(sql, e));

/** An account in words: "Gmail (you@work.com)". */
export const accountText = (e: Installed): string => (accountName(e) ? `${e.name} (${accountName(e)})` : e.name);

/** Which account new mail goes from: the area's, else the default, else the first. */
export function mailAccountFor(sql: Sql, areas: Area[]): Installed | null {
  return pickFor(
    mailAccounts(sql),
    areas.map((a) => a.settings.mail),
    readSettings(sql).accounts.mail,
  );
}

/**
 * The areas mail from one of the owner's own addresses belongs to: the areas
 * that send from the account with that address ("work@keyframes.studio" is
 * Keyframes' account, so mail from it is Keyframes'). None when no area names it.
 */
export function areasOfAddress(sql: Sql, address: string): string[] {
  const a = address.trim().toLowerCase();
  if (!a) return [];
  const account = providing(sql, "mail").find((e) => {
    const email = (e.data as { email?: unknown } | null)?.email;
    return typeof email === "string" && email.toLowerCase() === a;
  });
  if (!account) return [];
  return listAreas(sql)
    .filter((x) => x.state !== "archived" && x.settings.mail === account.id)
    .map((x) => x.id);
}

/** A calendar as areas and settings name it: a whole account ("gmail--2"), or one calendar in it ("gmail--2::Work"). */
export const CAL_SEP = "::";
export function calendarRef(ref: string): { account: string; calendar?: string } {
  const i = ref.indexOf(CAL_SEP);
  return i < 0 ? { account: ref } : { account: ref.slice(0, i), calendar: ref.slice(i + CAL_SEP.length) };
}

/**
 * Where new events go: the area's first calendar, else the owner's default,
 * else the first account that can add, with its own main calendar.
 */
export function calendarTargetFor(sql: Sql, areas: Area[]): { account: Installed; calendar?: string } | null {
  const can = calendarAccounts(sql).filter((e) => methodsOf(e).includes("add"));
  for (const ref of [...areas.flatMap((a) => a.settings.calendars), readSettings(sql).accounts.calendar]) {
    if (!ref) continue;
    const r = calendarRef(ref);
    const account = can.find((e) => e.id === r.account);
    if (account) return { account, ...(r.calendar ? { calendar: r.calendar } : {}) };
  }
  return can[0] ? { account: can[0] } : null;
}

/** A calendar target in words: "Google (you@work.com), Work". */
export const targetText = (t: { account: Installed; calendar?: string }) =>
  `${accountText(t.account)}${t.calendar ? `, ${t.calendar}` : ""}`;

function pickFor(all: Installed[], fromAreas: string[], fallback: string): Installed | null {
  for (const id of [...fromAreas, fallback]) {
    const e = id ? all.find((x) => x.id === id) : undefined;
    if (e) return e;
  }
  return all[0] ?? null;
}

/** An account the model named: by its id, its address, or the name the owner gave it. */
export function accountNamed(all: Installed[], said: string): Installed | null {
  const w = said.trim().toLowerCase();
  if (!w) return null;
  return (
    all.find((e) => e.id === w) ??
    all.find((e) => accountName(e)?.toLowerCase() === w) ??
    all.find((e) => (accountName(e) ?? "").toLowerCase().includes(w) || accountText(e).toLowerCase().includes(w)) ??
    null
  );
}

/** What a run is told, only when there's more than one of either. */
export function accountsLine(sql: Sql, areas: Area[]): string {
  const mail = mailAccounts(sql);
  const cals = calendarAccounts(sql);
  const out: string[] = [];
  if (mail.length > 1) {
    const now = mailAccountFor(sql, areas)!;
    out.push(
      `The owner has ${mail.length} mail accounts: ${mail.map(accountText).join(", ")}. A reply goes from the account its mail came to; new mail as them goes from ${accountText(now)} here, unless they say another (email_send's from).`,
    );
  }
  if (cals.length > 1) {
    const now = calendarTargetFor(sql, areas);
    out.push(
      `Their calendars, read together: ${cals.map(accountText).join(", ")}.${now ? ` New events go on ${targetText(now)} here, unless they say another (calendar_add's account and calendar).` : ""}`,
    );
  }
  return out.join(" ");
}
