// Search everything (M7 W20): what ⌘K finds. One look over what Atlas keeps, by the owner's words: files and
// pages it made, jobs, skills, automations, the people, places and memory in its records, and moments in the
// conversation. Every word must match; each kind gives its few best, newest first. It reads only.

import { listAutomations } from "./automations";
import { listRecords } from "./agent/views";
import { listFiles } from "./files";
import { listPages } from "./pages";
import type { JobView, SearchGroup, SearchHit } from "./protocol";
import { listSkills } from "./skills";
import type { Sql } from "./store/db";

const EACH = 4;

/** The words that must all appear, lowercase. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, 6);

export function searchEverything(sql: Sql, text: string, jobs: JobView[]): SearchHit[] {
  const words = wordsOf(text);
  if (!words.length) return [];
  const has = (...parts: Array<string | null | undefined>) => {
    const hay = parts.filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const hits: SearchHit[] = [];
  const add = (list: SearchHit[]) => hits.push(...list.sort((a, b) => b.at - a.at).slice(0, EACH));

  add(
    listFiles(sql)
      .filter((f) => has(f.name, f.note))
      .map((f) => ({ group: "files" as const, id: f.id, title: f.name, sub: f.note, at: f.updated_at, type: f.type })),
  );
  add(
    listPages(sql)
      .filter((p) => has(p.name))
      .map((p) => ({ group: "pages" as const, id: p.id, title: p.name, sub: `Version ${p.version}`, at: p.updated_at })),
  );
  add(
    jobs
      .filter((j) => !j.part_of && has(j.title, j.result))
      .map((j) => ({
        group: "jobs" as const,
        id: j.id,
        title: j.title,
        sub: j.state === "running" ? (j.activity === "working" ? "At work now" : "Waiting") : j.state === "done" ? "Done" : "Stopped",
        at: j.moved_at ?? j.started_at,
        live: j.state === "running" && j.activity === "working",
      })),
  );
  add(
    listSkills(sql)
      .filter((s) => has(s.name, s.description))
      .map((s) => ({ group: "skills" as const, id: s.id, title: s.name, sub: s.description, at: s.updated_at })),
  );
  add(
    listAutomations(sql)
      .filter((a) => has(a.name, a.about))
      .map((a) => ({ group: "automations" as const, id: a.id, title: a.name, sub: a.about, at: a.updated_at })),
  );
  // Records: matched by the store's own text search, then held to every word.
  const records = listRecords(sql, { text, limit: 40 }).records.filter((r) => has(r.name, r.fact));
  const group = (t: string): SearchGroup => (t === "person" ? "people" : t === "place" ? "places" : "memory");
  for (const g of ["people", "places", "memory"] as const)
    add(
      records
        .filter((r) => group(r.type) === g)
        .map((r) => ({ group: g, id: r.id, title: r.name, sub: r.fact ?? "", at: r.touched_at ?? r.updated_at, photo: r.photo ?? null })),
    );
  // The conversation: the owner's and Atlas's words, not a job's own thread.
  const like = `%${words[0]!.replace(/[%_]/g, "")}%`;
  add(
    sql
      .exec<{ id: string; at: number; kind: string; text: string }>(
        `SELECT id, at, kind, json_extract(body, '$.text') AS text FROM log
         WHERE kind IN ('message.in', 'message.out') AND json_extract(body, '$.job') IS NULL AND lower(json_extract(body, '$.text')) LIKE ?
         ORDER BY seq DESC LIMIT 40`,
        like,
      )
      .toArray()
      .filter((r) => typeof r.text === "string" && has(r.text))
      .map((r) => ({
        group: "conversation" as const,
        id: r.id,
        title: excerpt(r.text, words[0]!),
        sub: r.kind === "message.in" ? "You" : "Atlas",
        at: r.at,
        by: r.kind === "message.in" ? ("owner" as const) : ("atlas" as const),
      })),
  );
  return hits;
}

/** The part of a long message around the first word asked for. */
function excerpt(text: string, word: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 120) return flat;
  const at = Math.max(0, flat.toLowerCase().indexOf(word) - 40);
  return `${at > 0 ? "…" : ""}${flat.slice(at, at + 110)}…`;
}
