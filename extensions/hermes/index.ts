// Hermes Agent (Nous Research), moved in (§23.3). Hermes keeps its memory as
// two files in ~/.hermes/memories (HERMES_HOME when set): USER.md, its profile
// of the owner, and MEMORY.md, its own notes, each a list of entries with a
// line holding only "§" between them (tools/memory_tool_store.py,
// ENTRY_DELIMITER). Its skills are SKILL.md folders under ~/.hermes/skills,
// some in a category folder; skills/.bundled_manifest names the ones Hermes
// itself put there ("name:hash" a line), which aren't the owner's. `hermes
// backup` zips the whole folder, keys and sign-ins included: the app sends
// Atlas only the files named below and the skill folders, never the rest.

import type { Extension, ReadOut } from "../sdk";
import { baseName, entries, line } from "../lib/notes";

/** Hermes's own split between entries: a line with only "§" on it. */
const DELIMITER = /\n\s*§\s*\n/;

function memoryFile(text: string, path: string): ReadOut {
  const from = baseName(path).toUpperCase() === "USER.MD" ? "Hermes's profile of you" : "Hermes's notes";
  const body = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (DELIMITER.test(body) || /^\s*§\s*$/m.test(body)) {
    const notes = body
      .split(DELIMITER)
      .map((e) => line(e.replace(/^\s*§\s*$/gm, ""), 800))
      .filter((t) => t.length > 2)
      .slice(0, 400)
      .map((t) => ({ text: t, from }));
    return { notes };
  }
  // One entry, or a file written by hand without the delimiter: read as Markdown.
  return { notes: entries(body, { from }) };
}

/** The skills Hermes ships and keeps in step itself: "name:hash" a line (older ones, just the name). */
function bundled(text: string): ReadOut {
  const names = text
    .split("\n")
    .map((l) => l.trim().split(":")[0]!.trim())
    .filter((n) => n && !n.startsWith("#"));
  return { builtin_skills: [...new Set(names)] };
}

const ext: Extension = {
  manifest: {
    id: "hermes",
    name: "Hermes",
    version: "1.0.0",
    about: "Moves in what Hermes Agent knew about you, from its USER.md and MEMORY.md, and carries your skills over as they are.",
    provides: ["reader"],
    hosts: [],
    reads: {
      what: "Hermes's memory and skills",
      how: "Choose your Hermes folder, ~/.hermes (on a Mac, press Cmd+Shift+. in the picker to see folders that start with a dot). Atlas reads only its memories and skills; nothing else leaves your computer. A zip from hermes backup works too.",
      pick: "folder",
      files: ["memories/MEMORY.md", "memories/USER.md", "MEMORY.md", "USER.md", "skills/.bundled_manifest"],
      marks: ["memories/MEMORY.md", "memories/USER.md", "skills/.bundled_manifest"],
      skills: ["skills"],
    },
  },
  async read(_ctx, f) {
    const name = baseName(f.path);
    if (name === ".bundled_manifest") return bundled(f.text);
    if (/^(MEMORY|USER)\.md$/i.test(name)) return memoryFile(f.text, f.path);
    return {};
  },
};

export default ext;
