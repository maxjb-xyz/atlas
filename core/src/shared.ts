// Shared areas (VISION §6, §7.1), as the owner's Atlas keeps them: an area
// whose settings name the members it's shared with. Its records live here;
// a member's Atlas reads and writes them through the owner's agent.

import { getMember, members } from "./members";
import type { SharedArea } from "./protocol";
import { listAreas } from "./store/areas";
import type { Sql } from "./store/db";
import { createRecord, ownerName, ownerRecord } from "./store/records";

/** The areas shared with a member, or, for the owner (null), every area shared with anyone. */
export function sharedAreas(sql: Sql, member: string | null): SharedArea[] {
  const owner = ownerName(sql) || "the owner";
  const names = new Map(members(sql).map((m) => [m.id, m.name]));
  return listAreas(sql)
    .filter((a) => (member ? a.settings.shared_with.includes(member) : a.settings.shared_with.length > 0))
    .map((a) => ({
      id: a.id,
      name: a.name,
      about: a.about,
      with: [owner, ...a.settings.shared_with.map((id) => names.get(id) ?? "someone removed")],
      records: sql
        .exec<{ id: string; type: string; name: string; fields: string; updated_at: number; source: string }>(
          `SELECT id, type, name, fields, updated_at, source FROM records WHERE state = 'active' AND type != 'person' AND EXISTS (SELECT 1 FROM json_each(areas) WHERE value = ?) ORDER BY updated_at DESC LIMIT 200`,
          a.id,
        )
        .toArray()
        .map((r) => {
          const f = JSON.parse(r.fields) as { fact?: unknown };
          const via = (JSON.parse(r.source) as { via?: string }).via ?? "";
          return {
            id: r.id,
            type: r.type,
            name: r.name,
            fact: typeof f.fact === "string" ? f.fact : "",
            updated_at: r.updated_at,
            by: via.startsWith("member:") ? via.slice(7) : owner,
          };
        }),
    }));
}

/** Keeps something in a shared area, for everyone who shares it. */
export function sharedSave(
  sql: Sql,
  member: string | null,
  o: { area: string; name: string; fact: string; type: string },
): { ok: boolean; text: string } {
  const areas = sharedAreas(sql, member);
  const a = areas.find((x) => x.name.toLowerCase() === o.area.trim().toLowerCase()) ?? areas.find((x) => x.id === o.area);
  if (!a)
    return {
      ok: false,
      text: areas.length ? `No shared area is called "${o.area}". Shared: ${areas.map((x) => x.name).join(", ")}.` : "No areas are shared.",
    };
  const who = member ? getMember(sql, member)?.name : null;
  const r = createRecord(sql, {
    type: (["note", "place", "organization", "event", "task", "document"].includes(o.type) ? o.type : "note") as never,
    name: o.name.slice(0, 120),
    fields: { fact: o.fact.slice(0, 1_000) },
    source: { via: who ? `member:${who}` : "chat" },
    areas: [a.id],
  });
  return { ok: true, text: `Kept "${r.name}" in ${a.name}, for ${a.with.join(" and ")}.` };
}

/** A line for every prompt: what's shared and with whom, so Atlas knows what it writes there is seen by both. */
export function sharedLine(areas: SharedArea[], member: { name: string; owner: string } | null): string {
  const head = member
    ? `You are ${member.name}'s own Atlas. ${member.name} shares ${member.owner}'s Atlas; nothing of ${member.owner}'s is visible to you except the shared areas below.`
    : "";
  if (!areas.length) return head;
  return [
    head,
    `Shared areas (both see and write them; use shared_look and shared_save, and keep anything private out of them): ${areas
      .map((a) => `${a.name} (with ${a.with.join(", ")}; ${a.records.length} kept)`)
      .join("; ")}.`,
  ]
    .filter(Boolean)
    .join("\n");
}
