// Mail out (VISION §16.2, §12): `email_send` writes a mail as the owner
// (from their own mail, through the extension that holds it) or as Atlas
// (from its own address). It sends nothing itself: the mail goes to the way
// out, which asks the owner on a card they can edit, until they trust that
// kind of mail.

import { z } from "zod";
import { atlasMail } from "../atlasmail";
import { addressesIn, channelsOf, ownerAddresses } from "../contacts";
import { accountNamed, accountText, mailAccountFor, mailAccounts } from "../accounts";
import { hat } from "../context";
import { getExt } from "../extensions";
import { areaByName, listAreas, updateArea } from "../store/areas";
import { append } from "../store/log";
import { readSettings, writeSettings } from "../store/settings";
import { get as getRow } from "../store/log";
import { whoIs } from "./people";
import { defineTool, fail } from "./types";

export const emailSend = defineTool({
  name: "email_send",
  kind: "outside",
  status: "Writing it.",
  description: [
    "Write and send a mail. `as: owner` sends from the owner's own mail, so it reads as them: use it when the owner asks you to email someone for them ('email Doug that I'll be late').",
    "`as: atlas` sends from your own address, saying you're Atlas, an AI assistant writing for the owner: use it when the owner asks you to reach out yourself ('ask the dentist's office if they have anything Thursday'). Write it so the reader knows that.",
    "With more than one mail account, a new mail as the owner goes from the account the area uses (you're told which); `from` sends from another, by its address or name, when the owner says so. A reply always goes from the account its mail came to.",
    "`to` takes names of people you know or addresses. To answer a mail, pass its item id as `reply_to` (from noticed, or an item you were told about): it goes in that conversation, to its sender unless you say otherwise.",
    "It asks the owner first on a card they can edit, until they trust that kind of mail; then tell them in a few words it's waiting for their OK. If what you send asks something, open a loop (loop_open) so you notice if no answer comes.",
  ].join(" "),
  input: z.object({
    as: z.enum(["owner", "atlas"]).default("owner"),
    to: z.array(z.string().min(2).max(200)).max(10).default([]).describe("Names of people you know, or addresses."),
    cc: z.array(z.string().min(2).max(200)).max(10).optional(),
    subject: z.string().max(200).optional().describe("Needed for a new mail; a reply keeps its conversation's."),
    text: z.string().min(1).max(20_000).describe("The mail's words, plain text."),
    reply_to: z.string().max(64).optional().describe("The item id of the mail this answers."),
    from: z.string().max(200).optional().describe("Which of the owner's mail accounts, by its address or name, for a new mail as them."),
  }),
  async run(input, ctx) {
    if (!ctx.exit) return fail("Mail can't be sent from here.");
    // The mail it answers, when it's a reply.
    let thread: string | undefined;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let subject = input.subject?.trim();
    let replyFrom: string[] = [];
    let via: string | null = null;
    if (input.reply_to) {
      const row = getRow(ctx.sql, input.reply_to);
      if (!row || row.kind !== "sense" || typeof row.body.thread !== "string")
        return fail(`There's no mail with id ${input.reply_to}. noticed finds it.`);
      const b = row.body as Record<string, unknown>;
      thread = String(b.thread);
      inReplyTo = typeof b.message_id === "string" ? b.message_id : undefined;
      references = [
        ...(typeof b.references === "string" ? (b.references.match(/<[^<>\s]+>/g) ?? []) : []),
        ...(inReplyTo ? [inReplyTo] : []),
      ];
      const was = typeof b.subject === "string" ? b.subject : "";
      if (!subject && was) subject = /^re:/i.test(was) ? was : `Re: ${was}`;
      replyFrom = typeof b.from === "string" ? addressesIn(b.from) : [];
      // A reply goes out the way the mail came in: the owner's Gmail answers in Gmail, Atlas's address from Atlas's.
      if (b.source === "email" && input.as === "owner") return fail("That mail came to your own address, Atlas's: answer it as: atlas.");
      if (b.source !== "email") via = typeof b.ext === "string" ? b.ext : null;
    }
    if (!subject) return fail("A new mail needs a subject.");
    // Who it's to: addresses as they are, names through the people Atlas knows.
    const resolve = (list: string[]): { to: string[]; error?: string; person?: string } => {
      const out: string[] = [];
      let person: string | undefined;
      for (const w of list) {
        const a = addressesIn(w);
        if (a.length) {
          out.push(...a);
          continue;
        }
        const found = whoIs(ctx.sql, w);
        if (found.length > 1)
          return {
            to: [],
            error: `You know ${found.length} people as "${w}": ${found.map((r) => `${r.name} (${r.id})`).join(", ")}. Say which, or use an address.`,
          };
        const email = found[0] ? channelsOf(found[0]).find((c) => c.kind === "email")?.value : undefined;
        if (!email)
          return {
            to: [],
            error: found[0]
              ? `You don't have an email address for ${found[0].name}. Ask the owner, then contact_save it.`
              : `You don't know anyone as "${w}".`,
          };
        out.push(email.toLowerCase());
        person ??= found[0]!.id;
      }
      return { to: [...new Set(out)], ...(person ? { person } : {}) };
    };
    const to = resolve(input.to.length ? input.to : replyFrom);
    if (to.error) return fail(to.error);
    if (!to.to.length) return fail("Say who it's to.");
    const cc = resolve(input.cc ?? []);
    if (cc.error) return fail(cc.error);
    const mine = ownerAddresses(ctx.sql);
    let from: string;
    let name: string;
    if (input.as === "atlas") {
      const m = atlasMail(ctx.sql);
      if (!m) return fail("You don't have your own address yet. The owner sets it up in Abilities → Talks to others with → Mail to it.");
      from = m.address;
      via = "atlas";
      name = `Mail to ${to.to.join(", ")} from Atlas`;
    } else {
      // A reply goes from the account its mail came to; new mail from the one named, else the area's, else the default.
      const all = mailAccounts(ctx.sql);
      const named = !via && input.from ? accountNamed(all, input.from) : null;
      if (!via && input.from && !named)
        return fail(`The owner has no mail account "${input.from}". Theirs: ${all.map(accountText).join(", ") || "none"}.`);
      const sender = (via ? getExt(ctx.sql, via) : null) ?? named ?? mailAccountFor(ctx.sql, hat(ctx.sql));
      if (!sender || sender.state !== "on")
        return fail("The owner's mail isn't connected, so you can't send as them. They connect Gmail in Abilities → Services.");
      via = sender.id;
      // The connected account's own address, as the extension learned it; else the owner's first.
      const known = (sender.data as { email?: unknown } | null)?.email;
      from = typeof known === "string" ? known : ([...mine][0] ?? sender.name);
      name = `Mail to ${to.to.join(", ")} as you`;
    }
    return ctx.exit.request(
      {
        kind: "email",
        name,
        as: input.as,
        via,
        from,
        to: to.to,
        ...(cc.to.length ? { cc: cc.to } : {}),
        subject: subject.slice(0, 200),
        text: input.text,
        ...(thread ? { thread } : {}),
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        ...(references?.length ? { references } : {}),
        ...(to.person && to.to.length === 1 ? { person: to.person } : {}),
      },
      { run_id: ctx.run_id, source_log_id: ctx.source_log_id },
    );
  },
});

/**
 * Which of the owner's mail accounts new mail goes from (§6.2): by default,
 * or in one area. The owner sees it in Library → Areas and on the account's
 * card, with Undo on the receipt.
 */
export const mailAccount = defineTool({
  name: "mail_account",
  kind: "change_own",
  description:
    "Set which of the owner's mail accounts new mail as them goes from, when they say ('use my work Gmail for Keyframes', 'send from my personal address by default'): in one area, or by default when you leave area out. Replies always go from the account their mail came to.",
  input: z.object({
    account: z.string().min(1).max(200).describe("The account, by its address or name."),
    area: z.string().max(80).optional().describe("The area it's for; leave out for the default."),
  }),
  async run(input, ctx) {
    const all = mailAccounts(ctx.sql);
    if (all.length < 2) return fail("The owner has only one mail account connected, so there's nothing to pick.");
    const e = accountNamed(all, input.account);
    if (!e) return fail(`The owner has no mail account "${input.account}". Theirs: ${all.map(accountText).join(", ")}.`);
    if (input.area) {
      const a =
        areaByName(ctx.sql, input.area) ?? listAreas(ctx.sql).find((x) => x.name.toLowerCase().includes(input.area!.trim().toLowerCase()));
      if (!a)
        return fail(
          `There's no area called "${input.area}". Areas: ${
            listAreas(ctx.sql)
              .map((x) => x.name)
              .join(", ") || "none"
          }.`,
        );
      const before = a.settings.mail;
      updateArea(ctx.sql, a.id, { settings: { ...a.settings, mail: e.id } }, "atlas");
      return {
        ok: true,
        output: { area: a.name, sends_from: accountText(e) },
        receipt: { text: `${a.name} · new mail from ${accountText(e)}`, undo: { kind: "account.restore", area: a.id, before } },
      };
    }
    const before = readSettings(ctx.sql).accounts.mail;
    writeSettings(ctx.sql, { accounts: { ...readSettings(ctx.sql).accounts, mail: e.id } });
    append(ctx.sql, { actor: "atlas", kind: "settings.change", run_id: ctx.run_id, body: { keys: ["accounts"], why: "asked in chat" } });
    return {
      ok: true,
      output: { default: accountText(e) },
      receipt: { text: `New mail from ${accountText(e)} by default`, undo: { kind: "account.restore", area: null, before } },
    };
  },
});
