// OpenClaw, moved in (§23.3). OpenClaw remembers in plain Markdown in the
// agent's workspace, ~/.openclaw/workspace by default (docs/concepts/memory.md):
// USER.md, the owner's stable preferences and profile written as directives,
// each under a line like `<!-- observed: 2026-10-02 | status: active -->`
// (an entry marked superseded was replaced and is left out); MEMORY.md, its
// curated long-term memory; and memory/YYYY-MM-DD.md (or -<slug>.md), its
// daily notes. Skills are SKILL.md folders in the workspace's skills/, and
// ~/.openclaw/skills for managed ones. SOUL.md, IDENTITY.md and AGENTS.md are
// about OpenClaw itself, so they aren't read.

import type { Extension, Note, ReadOut } from "../sdk";
import { baseName, dateIn, entries, iso, line } from "../lib/notes";

/** USER.md's directives: each with its observed date, the superseded ones left out. */
function userModel(text: string): ReadOut {
  const body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!/<!--\s*observed:/i.test(body)) return { notes: entries(body, { from: "OpenClaw's profile of you" }) };
  const notes: Note[] = [];
  // Each directive block starts at its metadata line and runs to the next one.
  const blocks = body.split(/(?=<!--\s*observed:)/i);
  for (const b of blocks) {
    const meta = /<!--\s*observed:\s*([^|>]*?)\s*(?:\|\s*status:\s*([a-z]+))?\s*-->/i.exec(b);
    if (!meta) continue;
    if ((meta[2] ?? "active").toLowerCase() === "superseded") continue;
    const at = iso(meta[1]?.trim());
    // Only what's under this metadata line, up to the next heading.
    const own = b.slice(meta.index + meta[0].length).split(/\n#{1,6}\s/)[0]!;
    for (const n of entries(own, { from: "OpenClaw's profile of you", ...(at ? { at } : {}) })) {
      if (/^prefer \.\.\.$/i.test(n.text) || n.text.length < 4) continue;
      notes.push(n);
    }
  }
  return { notes };
}

const ext: Extension = {
  manifest: {
    id: "openclaw",
    name: "OpenClaw",
    version: "1.0.0",
    about: "Moves in what OpenClaw knew about you, from USER.md, MEMORY.md and its daily notes, and carries your skills over as they are.",
    provides: ["reader"],
    hosts: [],
    reads: {
      what: "OpenClaw's memory and skills",
      how: "Choose your OpenClaw workspace, ~/.openclaw/workspace, where USER.md, MEMORY.md and the memory folder are (on a Mac, press Cmd+Shift+. in the picker to see folders that start with a dot). Atlas reads only those and your skills; nothing else leaves your computer.",
      pick: "folder",
      files: ["USER.md", "MEMORY.md", "memory/*.md"],
      marks: ["memory/*.md", "IDENTITY.md", "HEARTBEAT.md", "AGENTS.md"],
      skills: ["skills"],
    },
  },
  async read(_ctx, f) {
    const name = baseName(f.path);
    if (name.toUpperCase() === "USER.MD" && !/(^|\/)memory\//.test(f.path)) return userModel(f.text);
    if (name.toUpperCase() === "MEMORY.MD" && !/(^|\/)memory\//.test(f.path))
      return { notes: entries(f.text, { from: "OpenClaw's long-term memory" }) };
    if (/(^|\/)memory\/[^/]+\.md$/i.test(f.path)) {
      const at = dateIn(f.path);
      const day = at ? at.slice(0, 10) : line(name.replace(/\.md$/i, ""), 40);
      return { notes: entries(f.text, { from: `OpenClaw's notes from ${day}`, ...(at ? { at } : {}) }) };
    }
    return {};
  },
};

export default ext;
