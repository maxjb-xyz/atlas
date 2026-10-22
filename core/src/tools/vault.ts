// The vault (§15) as Atlas reaches it: by name. Atlas says which entry goes
// into which of the page's fields, and the outbox fills the values in at the
// last step; Atlas never sees them. The first use on each site asks the
// owner, a card asks every time, and every use is a receipt.

import { z } from "zod";
import { hostOf } from "../web";
import { FIELDS, fillsOn, findEntry, vault } from "../vault";
import { defineTool, fail } from "./types";

const ALL_FIELDS = [...new Set(Object.values(FIELDS).flatMap((f) => Object.keys(f)))];
const ref = z.string().max(10).optional();

export const vaultFill = defineTool({
  name: "vault_fill",
  kind: "outside",
  status: "Filling that in from the vault.",
  timeoutMs: 60_000,
  description: [
    "Fill a vault entry into the browser's page, by the entry's name: the list in your context says what's there and which sites each one fills on. You never see the values, and you never type passwords or card numbers yourself.",
    "`fields` maps the entry's fields to the page's element numbers, such as { username: '4', password: '5' }; a login with a two-factor seed can fill `code` too. `press` is the button to press right after, such as Sign in, so a login is one step.",
    "It only fills on the sites the entry is tied to. The first use on each site waits for the owner's OK (a card waits every time): then tell them it's waiting in Inbox.",
  ].join(" "),
  input: z.object({
    entry: z.string().min(1).max(80).describe("The vault entry's name."),
    fields: z
      .object(Object.fromEntries(ALL_FIELDS.map((f) => [f, ref])) as Record<string, typeof ref>)
      .describe("The entry's fields you want filled, each with the element's number on the page."),
    press: z.string().max(10).optional().describe("The number of the button to press after filling, such as Sign in."),
  }),
  async run(input, ctx) {
    if (!ctx.browser || !ctx.exit) return fail("The vault can't be used from here.");
    const e = findEntry(ctx.sql, input.entry);
    if (!e) {
      const names = vault(ctx.sql).map((x) => x.name);
      return fail(
        names.length
          ? `There's no vault entry called "${input.entry}". The vault has: ${names.join(", ")}.`
          : "The vault is empty. The owner adds logins in Settings → Vault.",
      );
    }
    const here = ctx.browser.where();
    if (!here.open) return fail("The browser isn't open. Open the page first.");
    const host = hostOf(here.url);
    if (!fillsOn(e, host)) return fail(`${e.name} only fills on ${e.sites.join(", ")}, and the browser is on ${host}.`);
    const wanted = Object.entries(input.fields).filter((x): x is [string, string] => typeof x[1] === "string" && x[1] !== "");
    if (!wanted.length) return fail("Say which fields to fill, such as { username: '4', password: '5' }.");
    for (const [field] of wanted) {
      if (!(field in FIELDS[e.kind])) return fail(`${e.name} is a ${e.kind}; its fields are ${Object.keys(FIELDS[e.kind]).join(", ")}.`);
      if (field === "code" ? !e.totp : !e.values[field]) return fail(`${e.name} has no ${FIELDS[e.kind][field]!.toLowerCase()} saved.`);
    }
    try {
      for (const [, ref] of wanted) {
        const el = await ctx.browser.find(ref);
        if (!el || el.kind !== "field") return fail(`Element ${ref} isn't a field on the page now. Look again for the new numbers.`);
      }
      const press = input.press ? await ctx.browser.find(input.press) : null;
      if (input.press && !press) return fail(`There's no element ${input.press} on the page now. Look again for the new numbers.`);
      return ctx.exit.request(
        {
          kind: "vault",
          entry: e.id,
          name: e.name,
          host,
          url: here.url,
          card: e.kind === "card",
          fields: Object.fromEntries(wanted),
          ...(press ? { press: { ref: press.ref, text: press.text } } : {}),
        },
        { run_id: ctx.run_id, source_log_id: ctx.source_log_id },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
