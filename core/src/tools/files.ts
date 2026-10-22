// Files (§21.7): Atlas makes text files itself (a CSV, a Markdown write-up,
// a calendar file) and reads them back. Anything else, a spreadsheet or a
// PDF, is made in the workspace and kept from there.

import { z } from "zod";
import { findFile, isText, listFiles, readText, saveFile, typeOf } from "../files";
import { defineTool, fail } from "./types";

export const fileSave = defineTool({
  name: "file_save",
  kind: "change_own",
  status: "Making the file.",
  description: [
    "Make a text file the owner can open, download or send: a CSV for a spreadsheet, a Markdown or HTML document, a calendar file (.ics), JSON, code.",
    "Give it a name with the right extension; one with the same name is replaced. It appears in Library beside pages, and the owner sees it on the stage.",
    "For files that aren't text (a real spreadsheet, a PDF, a Word file, an image), make them in the workspace and keep them with workspace_keep.",
  ].join(" "),
  input: z.object({
    name: z.string().min(3).max(120).describe("The file name with its extension, like 'reminders-october.csv'."),
    text: z.string().max(2_000_000).describe("The whole file."),
    note: z.string().max(300).optional().describe("What it is, in a line, for Library."),
  }),
  async run(input, ctx) {
    if (!ctx.files) return fail("Files can't be made from here.");
    const type = typeOf(input.name);
    if (!isText(type) && type !== "application/octet-stream")
      return fail(`${input.name} isn't a text file. Make it in the workspace (workspace_run), then keep it with workspace_keep.`);
    try {
      const { file, replaced } = await saveFile(ctx.sql, ctx.files, {
        name: input.name,
        body: input.text,
        type: type === "application/octet-stream" ? "text/plain" : type,
        made_by: "atlas",
        note: input.note,
        run_id: ctx.run_id,
      });
      return {
        ok: true,
        output: { saved: file.name, id: file.id, bytes: file.size, ...(replaced ? { replaced: true } : {}) },
        receipt: { text: `${replaced ? "Replaced" : "Made"} file · ${file.name}`, view: { kind: "file", file: file.id } },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const fileRead = defineTool({
  name: "file_read",
  kind: "look",
  description:
    "Read one of the files you've made, by name, when it's text. A long one comes in parts: pass `more_from` as `start` to read on.",
  input: z.object({
    file: z.string().min(1).max(120).describe("The file's name or id."),
    start: z.number().int().min(0).optional(),
  }),
  async run(input, ctx) {
    if (!ctx.files) return fail("Files can't be read from here.");
    const f = findFile(ctx.sql, input.file);
    if (!f) {
      const names = listFiles(ctx.sql).map((x) => x.name);
      return fail(
        names.length
          ? `There's no file called "${input.file}". Your files are: ${names.slice(0, 30).join(", ")}.`
          : "You haven't made any files yet.",
      );
    }
    if (!isText(f.type)) return fail(`${f.name} is ${f.type}, not text. Open it in the workspace to work with it.`);
    try {
      const start = input.start ?? 0;
      const { text, length } = await readText(ctx.files, f, start);
      return {
        ok: true,
        output: { file: f.name, text, ...(start + text.length < length ? { more_from: start + text.length, of: length } : {}) },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const fileTools = [fileSave, fileRead];
