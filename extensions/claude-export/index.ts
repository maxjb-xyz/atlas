// A Claude export, moved in (§23.3). Anthropic emails a link to a zip from
// Settings → Privacy → Export data (the link lasts 24 hours, and may come
// without ".zip" on its name). Inside: conversations.json, a list of
// conversations each with `chat_messages` (`sender` "human" or "assistant",
// `text`, and `content` blocks), projects.json (each project's name,
// description and the instructions the owner wrote for it,
// `prompt_template`), users.json (the account), and for some accounts
// memories.json, what Claude remembered. A big account gets several zips; the
// first holds the account, projects and memory. This reader takes the owner's
// own words, their projects and Claude's memory, nothing Claude said.

import { Failure, type Extension, type Note, type ReadOut, type Talk } from "../sdk";
import { baseName, entries, iso, line, parseJson, said } from "../lib/notes";

const FROM = "Claude";

interface Block {
  type?: string;
  text?: unknown;
}

interface ChatMessage {
  sender?: string;
  text?: unknown;
  content?: Block[];
  created_at?: string;
}

interface Conversation {
  uuid?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ChatMessage[];
}

interface Project {
  uuid?: string;
  name?: string;
  description?: unknown;
  prompt_template?: unknown;
  is_starter_project?: boolean;
  updated_at?: string;
  created_at?: string;
}

const textOf = (m: ChatMessage): string => {
  if (Array.isArray(m.content) && m.content.length) {
    const t = m.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (t.trim()) return t;
  }
  return typeof m.text === "string" ? m.text : "";
};

function conversations(data: unknown, path: string): ReadOut {
  if (!Array.isArray(data))
    throw new Failure(`${path} isn't a list of conversations, so it doesn't look like a Claude export.`, "protocol");
  const talks: Talk[] = [];
  for (const c of data as Conversation[]) {
    if (!c || typeof c !== "object") continue;
    const mine = (c.chat_messages ?? []).filter((m) => m?.sender === "human").map(textOf);
    const words = said(mine);
    const at = iso(c.updated_at) ?? iso(c.created_at) ?? new Date(0).toISOString();
    if (words) talks.push({ id: String(c.uuid ?? `${c.name}:${at}`), title: line(c.name || "Untitled", 120), at, said: words, from: FROM });
  }
  return { talks, seen: data.length };
}

function projects(data: unknown): ReadOut {
  const notes: Note[] = [];
  for (const p of Array.isArray(data) ? (data as Project[]) : []) {
    // The example project every account starts with isn't the owner's.
    if (!p?.name || p.is_starter_project) continue;
    const at = iso(p.updated_at) ?? iso(p.created_at);
    const about = line(p.description, 800);
    const how = line(p.prompt_template, 1_200);
    notes.push({
      text: `A project of theirs in Claude, "${line(p.name, 80)}"${about ? `: ${about}` : "."}`,
      from: "A Claude project",
      ...(at ? { at } : {}),
    });
    if (how)
      notes.push({ text: `What they told Claude for "${line(p.name, 80)}": ${how}`, from: "A Claude project", ...(at ? { at } : {}) });
  }
  return { notes };
}

/** Claude's memory, however the file holds it: text under a key about memory, or files with their content. */
function memories(data: unknown): ReadOut {
  const notes: Note[] = [];
  const walk = (v: unknown, key: string, at?: string) => {
    if (notes.length >= 400) return;
    if (typeof v === "string") {
      if (/memor|content|text/i.test(key) && v.trim().length > 2)
        for (const n of entries(v, {
          from: /project/i.test(key) ? "Claude's memory of a project" : "Claude's memory",
          ...(at ? { at } : {}),
        }))
          notes.push(n);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, at));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const when = iso(o.updated_at ?? o.created_at) ?? at;
      for (const [k, x] of Object.entries(o)) {
        if (/uuid|_id$|^id$|account|path|^name$/i.test(k)) continue;
        // A project's memory is a map from its id to text: the text keeps its parent's key.
        walk(x, /memor|content|text/i.test(k) ? k : key, when);
      }
    }
  };
  walk(data, "memories");
  return { notes };
}

function users(data: unknown): ReadOut {
  const u = (Array.isArray(data) ? data[0] : data) as { full_name?: unknown } | undefined;
  const name = line(u?.full_name, 80);
  return name ? { notes: [{ text: `Their name is ${name}.`, from: "Your Claude account" }] } : {};
}

const ext: Extension = {
  manifest: {
    id: "claude-export",
    name: "Claude export",
    version: "1.0.0",
    about: "Moves in what Claude knew about you: its memory, your projects, and what you told it in your conversations.",
    provides: ["reader"],
    hosts: [],
    reads: {
      what: "A Claude export",
      how: "In Claude, open Settings → Privacy and choose Export data. Anthropic emails you a link that works for 24 hours; download the zip and drop it here. If it came as several zips, drop them all.",
      link: "https://claude.ai/settings/data-privacy-controls",
      pick: "file",
      files: ["conversations.json", "projects.json", "memories.json", "users.json"],
      marks: ["projects.json", "users.json", "memories.json"],
    },
  },
  async read(_ctx, f) {
    const name = baseName(f.path).toLowerCase();
    if (name === "conversations.json") return conversations(parseJson(f.text, f.path), f.path);
    if (name === "projects.json") return projects(parseJson(f.text, f.path));
    if (name === "memories.json") return memories(parseJson(f.text, f.path));
    if (name === "users.json") return users(parseJson(f.text, f.path));
    return {};
  },
};

export default ext;
