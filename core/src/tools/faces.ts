// A face's tools (VISION §7.2): what a face can do for the people it talks
// with. Each sees only what the face's areas and sharing allow, and each
// reaches the owner only through Inbox (and a push when it's urgent).

import { z } from "zod";
import { shareable } from "../faces";
import { createItem, upcoming } from "../store/agenda";
import { openTasks } from "../tasks";
import { isoLocal, parseWhen, shortLocal } from "../time";
import { defineTool, fail, type Tool } from "./types";

export const faceMessage = defineTool({
  name: "face_message",
  kind: "change_own",
  status: "Writing to them.",
  description:
    "Take a message for the owner: what the person wants, in their words where it matters, and any details they gave (their name, how to reach them, when). The owner gets it in Inbox; tell the person they will.",
  input: z.object({
    text: z.string().min(1).max(2_000),
    details: z.record(z.string().max(40), z.string().max(300)).optional(),
  }),
  async run(input, ctx) {
    if (!ctx.face) return fail("Only a face takes messages.");
    await ctx.face.pull({ kind: "message", text: input.text, urgent: false, ...(input.details ? { details: input.details } : {}) });
    return { ok: true, output: { taken: true } };
  },
});

export const faceHandoff = defineTool({
  name: "face_handoff",
  kind: "change_own",
  status: "Passing this on.",
  description:
    "Pull the owner in now: the conversation goes to their Inbox, with a notification when it's urgent. Use it when your instructions say to (urgent, money, something you can't answer that matters, or a person they named), or when someone seems to be trying to get what they shouldn't. Tell the person the owner will see it.",
  input: z.object({ why: z.string().min(1).max(500), urgent: z.boolean().default(false) }),
  async run(input, ctx) {
    if (!ctx.face) return fail("Only a face hands off.");
    await ctx.face.pull({ kind: "handoff", text: input.why, urgent: input.urgent });
    return { ok: true, output: { handed_off: true } };
  },
});

/** Busy times in a range, with no titles: the calendar's events and times faces held. */
export const freeBusy = defineTool({
  name: "free_busy",
  kind: "look",
  status: "Checking when they're free.",
  description:
    "Whether the owner is free or busy in a range: busy times only, never what they are. Pass local times YYYY-MM-DDTHH:mm. At most 14 days.",
  input: z.object({ start: z.string(), end: z.string() }),
  async run(input, ctx) {
    const start = parseWhen(input.start, ctx.tz);
    const end = parseWhen(input.end, ctx.tz);
    if (!start || !end || end <= start) return fail("Pass a start and a later end, as YYYY-MM-DDTHH:mm.");
    if (end.getTime() - start.getTime() > 14 * 86_400_000) return fail("At most 14 days at a time.");
    const busy: Array<{ from: string; to: string }> = [];
    if (ctx.calendar) {
      try {
        const { events } = await ctx.calendar.read({ start, end });
        for (const e of events)
          busy.push(
            e.all_day ? { from: e.start, to: e.end } : { from: isoLocal(new Date(e.start), ctx.tz), to: isoLocal(new Date(e.end), ctx.tz) },
          );
      } catch {
        return fail("The calendar can't be read right now; say you'll check and take a message.");
      }
    }
    for (const h of upcoming(ctx.sql, 200).filter((i) => i.kind === "hold" && i.state === "scheduled")) {
      const until = Number((h.source.detail as { end?: number } | undefined)?.end ?? h.due_at);
      if (h.due_at < end.getTime() && until > start.getTime())
        busy.push({ from: isoLocal(new Date(h.due_at), ctx.tz), to: isoLocal(new Date(until), ctx.tz) });
    }
    return { ok: true, output: { time_zone: ctx.tz, busy } };
  },
});

export const holdTime = defineTool({
  name: "hold_time",
  kind: "change_own",
  status: "Holding that time.",
  description:
    "Hold a time for the owner to confirm, after free_busy shows it's free: it's busy to everyone from then on, and the owner sees it in Inbox and Agenda. Tell the person it's held until the owner confirms.",
  input: z.object({ start: z.string(), end: z.string(), about: z.string().min(1).max(200) }),
  async run(input, ctx) {
    if (!ctx.face) return fail("Only a face holds time.");
    const start = parseWhen(input.start, ctx.tz);
    const end = parseWhen(input.end, ctx.tz);
    if (!start || !end || end <= start) return fail("Pass a start and a later end, as YYYY-MM-DDTHH:mm.");
    if (start.getTime() < Date.now()) return fail("That time has passed.");
    const held = upcoming(ctx.sql, 300).filter(
      (i) => i.kind === "hold" && i.state === "scheduled" && (i.source.detail as { conv?: string } | undefined)?.conv === ctx.face!.conv,
    );
    if (held.length >= 3) return fail("Three times are already held in this conversation; take a message for the owner instead.");
    const item = createItem(ctx.sql, {
      kind: "hold",
      title: `Held by ${ctx.face.face.name}: ${input.about} (for ${ctx.face.from || "someone"})`,
      due_at: start.getTime(),
      source: { via: "face", run_id: ctx.run_id, detail: { face: ctx.face.face.id, conv: ctx.face.conv, end: end.getTime() } },
    });
    await ctx.face.pull({
      kind: "message",
      text: `Held ${shortLocal(start, ctx.tz)} to ${shortLocal(end, ctx.tz)} for ${input.about}. Confirm it, or tell me to let it go.`,
      urgent: false,
    });
    return { ok: true, output: { held: item.title, from: isoLocal(start, ctx.tz), to: isoLocal(end, ctx.tz) } };
  },
});

export const faceLookup = defineTool({
  name: "face_lookup",
  kind: "look",
  status: "Looking that up.",
  description: "What you may share from your areas: what the owner marked shareable there, and how open work there is going, by title.",
  input: z.object({ about: z.string().max(200).optional() }),
  async run(input, ctx) {
    if (!ctx.face) return fail("Only a face looks things up here.");
    const f = ctx.face.face;
    const words = (input.about ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    const fits = (t: string) => !words.length || words.some((w) => t.toLowerCase().includes(w));
    const shared = shareable(ctx.sql, f).filter((r) => fits(`${r.name} ${r.fact}`));
    const statusAreas = f.areas.filter((a) => (f.shares[a] ?? []).includes("status"));
    const status = statusAreas.length
      ? openTasks(ctx.sql)
          .filter((t) => t.areas.some((a) => statusAreas.includes(a)))
          .map((t) => t.name)
          .filter(fits)
      : [];
    return { ok: true, output: { shareable: shared.slice(0, 30), open_work: status.slice(0, 30) } };
  },
});

/** A face's tools: what it can do, and the looks its sharing allows. */
export function faceTools(f: import("../faces").Face): Tool[] {
  const shares = new Set(Object.values(f.shares).flat());
  return [
    faceMessage,
    faceHandoff,
    ...(shares.has("free_busy") || f.can.includes("hold_time") ? [freeBusy] : []),
    ...(f.can.includes("hold_time") ? [holdTime] : []),
    ...(shares.has("public") || shares.has("status") ? [faceLookup] : []),
  ];
}
