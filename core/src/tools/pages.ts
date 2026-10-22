// Atlas's hands on pages (§21.7): making a page, giving one a new version,
// and reading one back. A page is Markdown with stage views kept in it as
// fenced `view` blocks; the views are checked against their contracts, the
// same as `show`'s, so a page never holds a view the app can't draw.

import { z } from "zod";
import { bodyOf, findPage, listPages, pageVersion, pageVersions, savePage, type Segment, segments } from "../pages";
import { resolve } from "./show";
import { defineTool, fail } from "./types";

export const pageSave = defineTool({
  name: "page_save",
  kind: "change_own",
  description: [
    "Make a page the owner keeps (a shoot plan, a trip itinerary, a weekly report, a study guide), or give one of their pages a new version (pass `page`).",
    "Use it when the owner asks you to write something up to keep, or to change or refresh a page they have. A new version keeps the old ones, and the owner can undo it.",
    "`body` is Markdown. To put a stage view in it, write a fenced block with the info string `view` holding the view's JSON, the same object `show` takes:",
    '```view\n{"kind":"area","area":"Keyframes"}\n```',
    "Area, person and automation views stay current by themselves. Lists, tables, drafts, plans and the text stay as written, so refresh them with a new version when they change.",
    "To change a page, read it with page_read first and send the whole new body. `note` says what changed, in a few words.",
  ].join(" "),
  input: z.object({
    page: z.string().max(80).optional().describe("The page to change: its name or id. Leave out to make a new one."),
    name: z.string().trim().min(1).max(80),
    body: z.string().min(1).max(60_000),
    note: z.string().max(300).describe("What changed, in a few words: 'Made', 'Added the gear list', 'Weather for Saturday'."),
  }),
  async run(input, ctx) {
    const old = input.page ? findPage(ctx.sql, input.page) : null;
    if (input.page && !old) return fail(`There's no page called "${input.page}". The owner's pages are: ${names(ctx.sql)}.`);
    const parts = segments(input.body);
    const blocks = (input.body.match(/^```view[ \t]*$/gm) ?? []).length;
    const views = parts.filter((p) => p.kind === "view").length;
    if (blocks !== views)
      return fail(
        `${blocks - views} of the view blocks didn't read as a view. Each needs valid JSON for one view (not a page), the same as show's input.`,
      );
    const fixed: Segment[] = [];
    for (const p of parts) {
      if (p.kind === "text") {
        fixed.push(p);
        continue;
      }
      const r = resolve(ctx.sql, p.view);
      if ("error" in r) return fail(r.error);
      fixed.push({ kind: "view", view: r.view });
    }
    let out;
    try {
      out = savePage(ctx.sql, { ...(old ? { id: old.id } : {}), name: input.name, body: bodyOf(fixed), note: input.note, by: "atlas" });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!out.row) return { ok: true, output: { unchanged: true, page: out.page.id, version: out.version } };
    return {
      ok: true,
      output: { page: out.page.id, name: out.page.name, version: out.version },
      receipt: {
        text: `${old ? "Changed" : "Made"} page · ${out.page.name}${old ? ` · version ${out.version}` : ""}`,
        view: { kind: "page", page: out.page.id },
        undo: { kind: "page.undo", id: out.page.id, version: out.version },
      },
    };
  },
});

export const pageRead = defineTool({
  name: "page_read",
  kind: "look",
  description:
    "Read one of the owner's pages: its newest body (Markdown, with its views as fenced `view` blocks) and its last versions. Read it before changing it with page_save.",
  input: z.object({ page: z.string().min(1).max(80).describe("The page's name or id.") }),
  async run(input, ctx) {
    const p = findPage(ctx.sql, input.page);
    if (!p) return fail(`There's no page called "${input.page}". The owner's pages are: ${names(ctx.sql)}.`);
    const v = pageVersion(ctx.sql, p.id)!;
    return {
      ok: true,
      output: {
        id: p.id,
        name: p.name,
        version: p.version,
        body: v.body,
        versions: pageVersions(ctx.sql, p.id)
          .slice(0, 5)
          .map((x) => ({ n: x.n, by: x.by, note: x.note, at: new Date(x.at).toISOString() })),
      },
    };
  },
});

const names = (sql: Parameters<typeof listPages>[0]) =>
  listPages(sql)
    .map((p) => p.name)
    .slice(0, 30)
    .join(", ") || "none yet";

export const pageTools = [pageSave, pageRead];
