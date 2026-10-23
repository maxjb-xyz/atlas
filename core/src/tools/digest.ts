// An area's look back (VISION §6, digests): what happened in an area over a
// span, what's open there, and what's waiting on whom. A routine's Atlas
// step uses it for "every Friday, the week in Work", and reports only when
// there's something worth saying.

import { z } from "zod";
import { detailOf, openLoops } from "../loops";
import { areaByName, listAreas } from "../store/areas";
import { openTasks } from "../tasks";
import { shortLocal } from "../time";
import { defineTool, fail } from "./types";

export const areaLook = defineTool({
  name: "area_look",
  kind: "look",
  description: [
    "Look back over an area (Work, Home, a project): what was said and kept there over the last days, what's open, and what's waiting on whom.",
    "Use it for a digest ('the week in Work') and for 'what's going on with Keyframes?'. Say only what's worth saying; when nothing happened, say so in a line or nothing.",
  ].join(" "),
  input: z.object({
    area: z.string().min(1).max(80),
    days: z.number().int().min(1).max(31).default(7),
  }),
  async run(input, ctx) {
    const a = areaByName(ctx.sql, input.area) ?? listAreas(ctx.sql).find((x) => x.name.toLowerCase().includes(input.area.toLowerCase()));
    if (!a)
      return fail(
        `There's no area called "${input.area}". Areas: ${
          listAreas(ctx.sql)
            .map((x) => x.name)
            .join(", ") || "none yet"
        }.`,
      );
    const since = Date.now() - input.days * 86_400_000;
    const tagged = `EXISTS (SELECT 1 FROM json_each(areas) WHERE value = ?)`;
    const said = ctx.sql
      .exec<{ kind: string; at: number; body: string }>(
        `SELECT kind, at, body FROM log WHERE at > ? AND kind IN ('message.in', 'message.out', 'sense', 'face.in') AND ${tagged} ORDER BY seq DESC LIMIT 60`,
        since,
        a.id,
      )
      .toArray()
      .reverse()
      .map((r) => {
        const b = JSON.parse(r.body) as { text?: string; what?: string; from?: string };
        const who =
          r.kind === "message.in"
            ? "owner"
            : r.kind === "message.out"
              ? "atlas"
              : r.kind === "face.in"
                ? `${b.from ?? "someone"} (to a face)`
                : "noticed";
        return { at: shortLocal(new Date(r.at), ctx.tz), who, text: String(b.text ?? b.what ?? "").slice(0, 300) };
      });
    const kept = ctx.sql
      .exec<{ name: string; type: string; fields: string; updated_at: number }>(
        `SELECT name, type, fields, updated_at FROM records WHERE state = 'active' AND updated_at > ? AND ${tagged} ORDER BY updated_at DESC LIMIT 40`,
        since,
        a.id,
      )
      .toArray()
      .map((r) => ({ name: r.name, type: r.type, fact: String((JSON.parse(r.fields) as { fact?: unknown }).fact ?? "").slice(0, 200) }));
    const tasks = openTasks(ctx.sql)
      .filter((t) => t.areas.includes(a.id))
      .map((t) => t.name);
    const loops = openLoops(ctx.sql).map((l) => ({
      waiting: l.title,
      by: shortLocal(new Date(l.due_at), ctx.tz),
      on: detailOf(l).waiting_on,
    }));
    return {
      ok: true,
      output: {
        area: a.name,
        since: shortLocal(new Date(since), ctx.tz),
        said,
        kept,
        open_tasks: tasks.slice(0, 40),
        // Loops aren't tagged with areas; those that fit this area are for you to judge.
        open_loops: loops.slice(0, 20),
      },
    };
  },
});
