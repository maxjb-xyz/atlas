// Shared by the readers that move in another assistant's memory (§23.3):
// Markdown memory files cut into entries, and the owner's own words cut short.

import { Failure, type Note } from "../sdk";

/** The most one entry keeps, and the most entries one file gives. */
export const ENTRY_CHARS = 600;
export const MAX_ENTRIES = 400;

/** Text as one tidy line, at most `n` characters. */
export function line(s: unknown, n = ENTRY_CHARS): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/**
 * A Markdown memory file as entries: each list item, and each paragraph
 * that isn't one, under the heading it sits in ("Work: Leads the design
 * team"). Comments, code fences, front matter and a file's title are left out.
 */
export function entries(md: string, o: { from: string; at?: string }): Note[] {
  const text = md
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "");
  const out: Note[] = [];
  let heading = "";
  let para: string[] = [];
  let first = true;
  const push = (t: string) => {
    const l = line(t.replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "));
    if (l.length < 3 || out.length >= MAX_ENTRIES) return;
    out.push({
      text: heading && !l.toLowerCase().startsWith(heading.toLowerCase()) ? `${heading}: ${l}` : l,
      from: o.from,
      ...(o.at ? { at: o.at } : {}),
    });
  };
  const flush = () => {
    if (para.length) push(para.join(" "));
    para = [];
  };
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    // A heading, or a line that's only bold words ("**Work context**"), as Claude's memory writes its sections.
    const h = /^#{1,6}\s+(.*)$/.exec(l) ?? /^\*\*([^*]{1,60}?):?\*\*:?$/.exec(l);
    if (h) {
      flush();
      // A file's own title ("# USER.md - User Model") isn't a heading its entries sit under.
      heading = first && /^#\s/.test(l) ? "" : line(h[1]!.replace(/[*_`]/g, ""), 60);
      first = false;
      continue;
    }
    first = false;
    if (!l) {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    if (item) {
      flush();
      push(item[1]!);
    } else if (/^\s{2,}\S/.test(raw) && out.length && !para.length) {
      // A list item that goes on over an indented line.
      const last = out[out.length - 1]!;
      last.text = line(`${last.text} ${l}`);
    } else para.push(l);
  }
  flush();
  return out;
}

/** A date from a file's name ("memory/2026-10-21.md", "2026-10-21-standup.md"), as ISO, or undefined. */
export function dateIn(path: string): string | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(path.split("/").pop() ?? "");
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The owner's own messages in one conversation, oldest first, each cut short, together at most `total` characters. */
export function said(messages: string[], o: { each?: number; total?: number } = {}): string {
  const each = o.each ?? 400;
  const total = o.total ?? 1_500;
  const parts: string[] = [];
  let n = 0;
  for (const m of messages) {
    const l = line(m, each);
    if (!l) continue;
    if (n + l.length > total) {
      if (total - n > 80) parts.push(line(l, total - n));
      break;
    }
    parts.push(l);
    n += l.length + 1;
  }
  return parts.join("\n");
}

/** A time as ISO: seconds since 1970 (ChatGPT's), milliseconds, or a date string; undefined when it isn't one. */
export function iso(t: unknown): string | undefined {
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  if (typeof t === "string" && t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

/** Reads a file's text as JSON, or says plainly that it isn't. */
export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new Failure(`${path} isn't JSON Atlas can read: ${err instanceof Error ? err.message : String(err)}`, "protocol");
  }
}

/** The file's name without its folders. */
export const baseName = (path: string) => path.split("/").pop() ?? path;
