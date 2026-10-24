// Shared areas (VISION §6, §7.1): an area the owner shares with a member
// lives in the owner's Atlas, and both see and write it. These tools reach
// it from either side: what's in it, and something kept there for both.

import { z } from "zod";
import { defineTool, fail } from "./types";

export const sharedLook = defineTool({
  name: "shared_look",
  kind: "look",
  status: "Checking what's shared.",
  description:
    "What's in the areas shared between the owner and the people they share Atlas with (a household, a project): each area, who shares it, and what's kept there. Use it for questions about those shared things.",
  input: z.object({ area: z.string().max(80).optional() }),
  async run(input, ctx) {
    if (!ctx.shared) return fail("Nothing is shared here.");
    const all = await ctx.shared.list();
    const want = input.area?.toLowerCase();
    const areas = want ? all.filter((a) => a.name.toLowerCase().includes(want)) : all;
    if (!areas.length)
      return fail(
        all.length ? `No shared area is called "${input.area}". Shared: ${all.map((a) => a.name).join(", ")}.` : "No areas are shared yet.",
      );
    return { ok: true, output: { areas: areas.map((a) => ({ ...a, records: a.records.slice(0, 60) })) } };
  },
});

export const sharedSave = defineTool({
  name: "shared_save",
  kind: "change_own",
  status: "Saving it to share.",
  description:
    "Keep something in a shared area, where everyone who shares it sees it: 'the plumber comes Tuesday' in Home. Only for things meant for both; anything private stays in your own memory (remember).",
  input: z.object({
    area: z.string().min(1).max(80),
    name: z.string().min(1).max(120).describe("A short name: 'Plumber visit'."),
    fact: z.string().min(1).max(1_000).describe("The thing itself, in one plain sentence."),
    type: z.enum(["note", "place", "organization", "event", "task", "document"]).default("note"),
  }),
  async run(input, ctx) {
    if (!ctx.shared) return fail("Nothing is shared here.");
    const out = await ctx.shared.save(input);
    return out.ok ? { ok: true, output: { kept: out.text }, receipt: { text: `Shared · ${input.area} · ${input.name}` } } : fail(out.text);
  },
});

export const sharedTools = [sharedLook, sharedSave];
