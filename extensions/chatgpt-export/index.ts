// A ChatGPT export, moved in (§23.3). OpenAI emails a link to a zip from
// Settings → Data controls → Export data. Its conversations are in
// conversations.json (a list, one per conversation, each a tree of messages
// in `mapping` with the branch shown last ending at `current_node`), or in
// conversations-000.json, -001.json and on for a big account. This reader
// takes from each conversation only what's the owner's: their own messages,
// the custom instructions they wrote ("user_editable_context"), and what
// ChatGPT saved to its memory along the way (a message to its `bio` tool,
// and the memory it was shown, "model_editable_context"). Nothing else in
// the zip is sent to Atlas: not chat.html, not files or images.

import { type Extension, Failure, type Note, type ReadOut, type Talk } from "../sdk";
import { baseName, entries, iso, line, parseJson, said } from "../lib/notes";

const FROM = "ChatGPT";

interface Message {
  author?: { role?: string; name?: string | null };
  create_time?: number | null;
  content?: {
    content_type?: string;
    parts?: unknown[];
    text?: unknown;
    user_profile?: unknown;
    user_instructions?: unknown;
    model_set_context?: unknown;
  };
  recipient?: string;
  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    user_context_message_data?: { about_user_message?: unknown; about_model_message?: unknown };
  };
}

interface Conversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, { id?: string; message?: Message | null; parent?: string | null; children?: string[] }>;
}

/** What a custom instructions field says, without the framing ChatGPT puts around it for the model. */
function ownWords(v: unknown): string {
  if (typeof v !== "string") return "";
  const fenced = /```([\s\S]*?)```/.exec(v);
  return (fenced ? fenced[1]! : v).trim();
}

/** A message's text: its string parts, or its text. */
function textOf(m: Message): string {
  const c = m.content;
  if (!c) return "";
  if (Array.isArray(c.parts)) return c.parts.filter((p): p is string => typeof p === "string").join("\n");
  return typeof c.text === "string" ? c.text : "";
}

/** The conversation as the owner last saw it: from the root to `current_node`, or every message by time when there's none. */
function shown(c: Conversation): Message[] {
  const map = c.mapping ?? {};
  const out: Message[] = [];
  if (c.current_node && map[c.current_node]) {
    const seen = new Set<string>();
    for (let id: string | null | undefined = c.current_node; id && map[id] && !seen.has(id); id = map[id]!.parent) {
      seen.add(id);
      const m = map[id]!.message;
      if (m) out.push(m);
    }
    return out.reverse();
  }
  return Object.values(map)
    .map((n) => n.message)
    .filter((m): m is Message => Boolean(m))
    .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
}

/** The memory ChatGPT was shown, one entry a line: "1. [2025-03-02]. Is vegetarian." */
function memoryLines(v: unknown, at?: string): Note[] {
  if (typeof v !== "string") return [];
  const out: Note[] = [];
  for (const raw of v.split("\n")) {
    const m = /^\s*\d+\.\s*(?:\[(\d{4}-\d{2}-\d{2})\]\.?\s*)?(.+)$/.exec(raw);
    if (!m) continue;
    const text = line(m[2]);
    if (text.length > 2) out.push({ text, from: "ChatGPT's memory", ...((iso(m[1]) ?? at) ? { at: iso(m[1]) ?? at } : {}) });
  }
  return out;
}

function conversations(list: unknown, path: string): ReadOut {
  const all = Array.isArray(list)
    ? (list as Conversation[])
    : Array.isArray((list as { conversations?: unknown })?.conversations)
      ? ((list as { conversations: Conversation[] }).conversations ?? [])
      : null;
  if (!all) throw new Failure(`${path} isn't a list of conversations, so it doesn't look like a ChatGPT export.`, "protocol");
  const notes = new Map<string, Note>();
  const note = (n: Note) => {
    const k = n.text.toLowerCase();
    const was = notes.get(k);
    if (!was || (n.at && (!was.at || n.at > was.at))) notes.set(k, n);
  };
  const talks: Talk[] = [];
  for (const c of all) {
    if (!c || typeof c !== "object") continue;
    const at = iso(c.update_time) ?? iso(c.create_time) ?? new Date(0).toISOString();
    const mine: string[] = [];
    for (const m of shown(c)) {
      const ct = m.content?.content_type;
      const when = iso(m.create_time) ?? at;
      if (ct === "user_editable_context") {
        const about = ownWords(m.content?.user_profile);
        const how = ownWords(m.content?.user_instructions);
        if (about) note({ text: line(`About them, in their own words: ${about}`, 1_200), from: "ChatGPT's custom instructions", at: when });
        if (how) note({ text: line(`How they want answers: ${how}`, 1_200), from: "ChatGPT's custom instructions", at: when });
        continue;
      }
      const ctx = m.metadata?.user_context_message_data;
      if (ctx) {
        const about = ownWords(ctx.about_user_message);
        const how = ownWords(ctx.about_model_message);
        if (about) note({ text: line(`About them, in their own words: ${about}`, 1_200), from: "ChatGPT's custom instructions", at: when });
        if (how) note({ text: line(`How they want answers: ${how}`, 1_200), from: "ChatGPT's custom instructions", at: when });
      }
      if (ct === "model_editable_context") {
        for (const n of memoryLines(m.content?.model_set_context, when)) note(n);
        continue;
      }
      // What ChatGPT saved to its memory in this conversation.
      if (m.recipient === "bio" && m.author?.role === "assistant") {
        const t = line(textOf(m));
        if (t) note({ text: t, from: "ChatGPT's memory", at: when });
        continue;
      }
      if (m.author?.role === "user" && !m.metadata?.is_visually_hidden_from_conversation) {
        const t = textOf(m).trim();
        if (t) mine.push(t);
      }
    }
    const words = said(mine);
    if (words)
      talks.push({
        id: String(c.conversation_id ?? c.id ?? `${c.title}:${at}`),
        title: line(c.title || "Untitled", 120),
        at,
        said: words,
        from: FROM,
      });
  }
  return { notes: [...notes.values()], talks, seen: all.length };
}

/** A memories file, if an export has one: a list of memories, as strings or objects with their text. */
function memories(data: unknown): ReadOut {
  const notes: Note[] = [];
  const walk = (v: unknown, at?: string) => {
    if (notes.length >= 400) return;
    if (typeof v === "string") {
      for (const n of entries(v, { from: "ChatGPT's memory", ...(at ? { at } : {}) })) notes.push(n);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, at));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const when = iso(o.updated_at ?? o.created_at ?? o.update_time ?? o.create_time) ?? at;
      const text = o.content ?? o.memory ?? o.text ?? o.value;
      if (typeof text === "string") walk(text, when);
      else for (const x of Object.values(o)) if (typeof x === "object") walk(x, when);
    }
  };
  walk(data);
  return { notes };
}

const ext: Extension = {
  manifest: {
    id: "chatgpt-export",
    name: "ChatGPT export",
    icon_invert: true,
    version: "1.0.0",
    about: "Moves in what ChatGPT knew about you: your custom instructions, its memory, and what you told it in your conversations.",
    provides: ["reader"],
    hosts: [],
    reads: {
      what: "A ChatGPT export",
      how: "In ChatGPT, open Settings → Data controls → Export data, and choose Export. OpenAI emails you a link to a zip within a day or so; download it and drop it here.",
      link: "https://chatgpt.com/#settings/DataControls",
      pick: "file",
      files: ["conversations.json", "conversations-*.json", "memories.json", "memory.json"],
      marks: ["chat.html", "message_feedback.json", "shared_conversations.json", "model_comparisons.json", "user.json"],
    },
  },
  async read(_ctx, f) {
    const name = baseName(f.path).toLowerCase();
    if (/^conversations(?:-\d+)?\.json$/.test(name)) return conversations(parseJson(f.text, f.path), f.path);
    if (name === "memories.json" || name === "memory.json") return memories(parseJson(f.text, f.path));
    return {};
  },
};

export default ext;
