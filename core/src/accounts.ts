// Accounts (VISION §6.2, §17): when the owner has more than one mail or
// calendar account, which one Atlas uses. A reply goes from the account its
// mail came in on; anything new goes from the account the area names, else
// the owner's default, else the first. Calendars are all read together. The
// model is told the accounts, and can pick one when the owner says to.

import type { Area } from "./store/areas";
import { accountName, type Installed, methodsOf, providing } from "./extensions";
import type { Sql } from "./store/db";
import { readSettings } from "./store/settings";

/** The owner's mail accounts that can send, oldest first. */
export const mailAccounts = (sql: Sql): Installed[] => providing(sql, "mail").filter((e) => methodsOf(e).includes("mail"));
/** The owner's calendars, oldest first. */
export const calendarAccounts = (sql: Sql): Installed[] => providing(sql, "calendar").filter((e) => methodsOf(e).includes("calendar"));

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
  if (cals.length > 1) out.push(`Their calendars, read together: ${cals.map(accountText).join(", ")}.`);
  return out.join(" ");
}
