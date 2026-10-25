// Which files a reader takes (§23.3, moving in), shared by the app, which
// opens the owner's export or folder on their own device and sends only
// these, and the core, which checks them again. Nothing here knows any one
// format: each reader's manifest names its files (extensions/sdk.ts, ReaderSpec).

import type { ReaderSpec } from "../../extensions/sdk";

export type { ReaderSpec } from "../../extensions/sdk";

/** A path as the app and the core compare it: forward slashes, no leading "./" or "/". */
export const cleanPath = (p: string) =>
  p
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .replace(/\/{2,}/g, "/");

const hidden = (path: string) => path.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..");

/** Whether a path ends with a pattern: "memories/USER.md" matches "hermes/memories/USER.md"; "*" is any name within one folder. */
export function matchesPath(pattern: string, path: string): boolean {
  const p = cleanPath(path);
  const re = new RegExp(
    `(?:^|/)${cleanPath(pattern)
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
    "i",
  );
  return re.test(p);
}

/**
 * The folders that hold a SKILL.md under one of the reader's skill folders, leaving out hidden ones (Hermes's
 * .archive and .hub) and any inside another skill's folder (an example skill in its references).
 */
export function skillFolders(spec: ReaderSpec, paths: string[]): string[] {
  const roots = spec.skills ?? [];
  if (!roots.length) return [];
  const out = new Set<string>();
  for (const raw of paths) {
    const p = cleanPath(raw);
    if (!/(^|\/)SKILL\.md$/.test(p)) continue;
    const folder = p.replace(/\/?SKILL\.md$/, "");
    const parts = folder.split("/");
    // Somewhere under a folder named like one of the reader's: ".../skills/<category>/<name>".
    const at = parts.findIndex((x) => roots.includes(x));
    if (at < 0 || at === parts.length - 1) continue;
    if (hidden(parts.slice(at).join("/"))) continue;
    out.add(folder);
  }
  const kept: string[] = [];
  for (const f of [...out].sort((a, b) => a.length - b.length)) if (!kept.some((k) => f.startsWith(`${k}/`))) kept.push(f);
  return kept.sort();
}

/** Whether a reader takes this file: one of its `files` (the folder picked may itself be hidden, like .hermes), not inside a skill folder. */
export function readerTakes(spec: ReaderSpec, path: string, skills: string[] = []): boolean {
  const p = cleanPath(path);
  if (skills.some((f) => p.startsWith(`${f}/`))) return false;
  return spec.files.some((pat) => matchesPath(pat, p));
}

/** How well a set of paths fits a reader: its marks count most, then its files; 0 is not at all. */
export function fit(spec: ReaderSpec, paths: string[]): number {
  let n = 0;
  for (const raw of paths) {
    if ((spec.marks ?? []).some((m) => matchesPath(m, raw))) n += 3;
    if (readerTakes(spec, raw)) n += 1;
  }
  return n;
}
