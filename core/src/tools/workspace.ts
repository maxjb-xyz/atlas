// The workspace (§9.1): Atlas's own computer, a container with a shell,
// Python and Node, files in /workspace, and no internet but the websites
// the owner allows. Running things there changes only Atlas's own space;
// opening a website to it asks the owner once (§12).

import { z } from "zod";
import { cleanName, saveFile } from "../files";
import { fillsOn, vault } from "../vault";
import { defineTool, fail } from "./types";

/** The start and the end of long output: errors are usually at the end. */
const tail = (s: string, n = 12_000) =>
  s.length <= n ? s : `${s.slice(0, 2_000)}\n… (${s.length - n} characters left out) …\n${s.slice(-(n - 2_000))}`;

export const workspaceRun = defineTool({
  name: "workspace_run",
  kind: "change_own",
  status: "Working on it in the workspace.",
  timeoutMs: 16 * 60_000,
  description: [
    "Run a shell command in your workspace: a Linux computer of your own with bash, Python 3 (with pandas, openpyxl, python-docx, reportlab, matplotlib, requests), Node, git, curl, jq and sqlite3. It starts in /workspace, which keeps its files between sessions.",
    "Use it to compute, convert, analyse data, write and run scripts, and make files that aren't plain text (a real spreadsheet, a PDF, a Word file, a chart image); then keep a file for the owner with workspace_keep.",
    "It can only reach websites the owner has allowed. When the result lists `blocked` sites, ask for the one you need with workspace_allow, then run again; pip and npm need their package sites allowed too.",
    "The first run after a while starts the workspace (a few seconds; the very first time, a minute or two to set up). The owner can watch it live in the app.",
  ].join(" "),
  input: z.object({
    command: z.string().min(1).max(20_000).describe("The bash command or script to run, from /workspace."),
    timeout_s: z.number().int().min(5).max(900).optional().describe("Most seconds it may take. Default 120."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace) return fail("The workspace can't be used from here.");
    try {
      const r = await ctx.workspace.run(input.command, { run_id: ctx.run_id, timeout_s: input.timeout_s ?? 120 });
      return {
        ok: true,
        output: {
          exit: r.exit,
          ...(r.exit === 124 ? { timed_out: `It ran past ${input.timeout_s ?? 120} seconds and was stopped.` } : {}),
          output: tail(r.output) || "(nothing printed)",
          seconds: Math.round(r.ms / 100) / 10,
          ...(r.blocked.length
            ? { blocked: r.blocked, note: "These sites aren't allowed yet. Ask for the one you need with workspace_allow, then run again." }
            : {}),
          ...(r.notes.length ? { notes: r.notes } : {}),
        },
        receipt: { text: `Ran in the workspace · ${input.command.split("\n")[0]!.slice(0, 60)}`, view: { kind: "workspace" } },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const workspaceAllow = defineTool({
  name: "workspace_allow",
  kind: "outside",
  status: "Asking to open that site to the workspace.",
  description: [
    "Ask to let the workspace reach a website, such as pypi.org for pip or api.github.com. The owner is asked once per site; after that it's remembered, subdomains included.",
    "If a key in the vault is tied to that site, the workspace's requests there carry it, added outside the workspace: code never sees it. Tell the owner in a few words it's waiting for their OK.",
  ].join(" "),
  input: z.object({
    site: z.string().min(3).max(200).describe("The hostname, like pypi.org."),
    why: z.string().min(3).max(300).describe("Why the workspace needs it, in a line the owner reads on the card."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace || !ctx.exit) return fail("The workspace can't be opened to sites from here.");
    let host: string;
    try {
      host = new URL(/^[a-z]+:\/\//i.test(input.site) ? input.site : `https://${input.site}`).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return fail(`"${input.site}" isn't a website. Give its hostname, like pypi.org.`);
    }
    if (!host.includes(".")) return fail(`"${host}" isn't a website. Give its hostname, like pypi.org.`);
    const key = vault(ctx.sql).find((e) => e.kind === "key" && fillsOn(e, host));
    return ctx.exit.request(
      {
        kind: "site",
        host,
        name: `Let the workspace reach ${host}`,
        why: input.why,
        ...(key ? { key: { entry: key.id, name: key.name } } : {}),
      },
      { run_id: ctx.run_id, source_log_id: ctx.source_log_id },
    );
  },
});

export const workspaceKeep = defineTool({
  name: "workspace_keep",
  kind: "change_own",
  status: "Keeping that file for you.",
  timeoutMs: 120_000,
  description:
    "Keep a file from the workspace for the owner: it goes into Library beside pages, opens on the stage, and downloads. Use it for what you made there, such as a spreadsheet, a PDF or a chart.",
  input: z.object({
    path: z.string().min(1).max(500).describe("The file's path, relative to /workspace or absolute."),
    name: z.string().max(120).optional().describe("The name to keep it under, with its extension. Default: the file's own name."),
    note: z.string().max(300).optional().describe("What it is, in a line, for Library."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace || !ctx.files) return fail("Files can't be kept from here.");
    const path = input.path.startsWith("/") ? input.path : `/workspace/${input.path}`;
    try {
      const name = cleanName(input.name ?? path.split("/").pop()!);
      const got = await ctx.workspace.read(path);
      if (!got.ok) return fail(`Couldn't read ${path} in the workspace: ${got.error}`);
      const { file, replaced } = await saveFile(ctx.sql, ctx.files, {
        name,
        body: got.bytes,
        made_by: "atlas",
        note: input.note,
        run_id: ctx.run_id,
      });
      return {
        ok: true,
        output: { kept: file.name, bytes: file.size, ...(replaced ? { replaced: true } : {}) },
        receipt: { text: `${replaced ? "Replaced" : "Made"} file · ${file.name}`, view: { kind: "file", file: file.id } },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const workspacePreview = defineTool({
  name: "workspace_preview",
  kind: "change_own",
  status: "Opening a preview.",
  description: [
    "Give the owner a link to a web server you started in the workspace (listening on 0.0.0.0, in the background), to see what you built: a small site, a dashboard, a report.",
    "The link works for a day, for anyone who has it; it shows nothing once the workspace sleeps. Start the server with nohup or & in workspace_run first.",
  ].join(" "),
  input: z.object({ port: z.number().int().min(1).max(65_535) }),
  async run(input, ctx) {
    if (!ctx.workspace) return fail("Previews can't be made from here.");
    try {
      const p = await ctx.workspace.preview(input.port);
      return {
        ok: true,
        output: { url: p.url, until: new Date(p.expires).toISOString() },
        receipt: { text: `Preview · port ${input.port}`, view: { kind: "workspace" } },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const packagesInstall = defineTool({
  name: "packages_install",
  kind: "change_own",
  status: "Installing that.",
  timeoutMs: 16 * 60_000,
  description: [
    'Install system tools in the workspace from Debian, by package name ("sox", "imagemagick", "yt-dlp", "libreoffice-writer"): what your shell can\'t install for itself without root.',
    "Atlas installs them as root and puts them back whenever the workspace starts again, so install once. For Python or Node libraries, pip install --user or npm in your folder instead.",
  ].join(" "),
  input: z.object({
    packages: z.array(z.string().min(1).max(63)).min(1).max(20).describe("Debian package names."),
  }),
  async run(input, ctx) {
    if (!ctx.workspace) return fail("There's no workspace here.");
    const r = await ctx.workspace.install(input.packages);
    return r.ok
      ? { ok: true, output: { installed: input.packages }, receipt: { text: `Installed · ${input.packages.join(", ")}` } }
      : fail(r.note);
  },
});

export const workspaceTools = [workspaceRun, workspaceAllow, workspaceKeep, workspacePreview, packagesInstall];
