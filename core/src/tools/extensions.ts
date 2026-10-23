// Atlas writing an extension (VISION §17): when the owner wants Atlas to hear
// from or reach a service it has no extension for, Atlas writes one as a
// draft. It never runs until the owner reads it and installs it in Settings,
// where it shows what it can touch.

import { z } from "zod";
import { defineTool, fail } from "./types";

export const extensionDraft = defineTool({
  name: "extension_draft",
  kind: "change_own",
  status: "Writing it.",
  description: [
    "Write an extension for a service you have none for, when the owner asks for one (their home server's events, a service's notifications): it's kept as a draft, and runs only after the owner reads it and installs it in Settings → Extensions.",
    "The code is one plain JavaScript ES module (no imports, no TypeScript) whose default export is an object with `manifest` and the calls it takes.",
    "manifest: { id (lowercase, like 'homeserver'), name, version ('1.0.0'), about (one sentence the owner reads before installing), provides (['sense'] for things to notice), hosts (the only hosts it may reach), secrets ([{ name, label, help }] the owner pastes), every (minutes between looks, for a service that can't post), receives ({} if the service posts to it) }.",
    "Calls: look(ctx) returns { items, cursor } with what's new since ctx.cursor; receive(ctx, req) reads a post ({ method, headers, body, query }) into { items, reply: { status, json } }; test(ctx) returns { text }.",
    "An item is { event, what (one line saying what happened), key (so the same thing counts once), thread, from, link }.",
    "Use fetch for requests, and ctx.secret('name') where a secret goes (in a header, the address or the body): it's a placeholder that's filled in as the request leaves, so the extension never holds the value. Throw an Error with the service's status and words when something fails.",
    "Tell the owner it's a draft waiting in Settings → Extensions, and what it would reach.",
  ].join(" "),
  input: z.object({ code: z.string().min(80).max(100_000).describe("The whole module, as JavaScript.") }),
  async run(input, ctx) {
    if (!ctx.extensions) return fail("Extensions can't be written from here.");
    try {
      const d = await ctx.extensions.draft(input.code);
      return {
        ok: true,
        output: {
          draft: d.id,
          name: d.name,
          reaches: d.hosts,
          note: "Waiting for the owner to read it and install it in Settings → Extensions.",
        },
        receipt: { text: `Draft · ${d.name} · install it in Settings → Extensions` },
      };
    } catch (err) {
      return fail(`The extension wasn't kept: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
