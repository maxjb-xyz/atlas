// People and open loops (VISION §7.1, §10.4). `person` answers "who's Doug?"
// from what Atlas knows: how to reach them, what's open with them, and when
// the owner was last in touch. `contact_save` keeps how to reach someone and
// how much they're trusted. `loop_open` and `loop_close` keep what Atlas is
// waiting to hear by a time. All change only the owner's own things, so
// Atlas does them with a receipt and Undo (§12.1).

import { z } from "zod";
import { CHANNEL_KINDS, type Channel, addChannels, channelsOf, findPerson, lastTouch, TRUST, trustOf, upsertPerson } from "../contacts";
import { closeLoop, detailOf, openLoop, openLoops } from "../loops";
import { correctRecord, getRecord, recordsNamed } from "../store/records";
import { fitsOf, openTasks, personIn } from "../tasks";
import { isoLocal, parseWhen, shortLocal } from "../time";
import { defineTool, fail } from "./types";
import type { Sql } from "../store/db";
import type { AtlasRecord } from "../store/records";

/** The person someone means: by a channel ("doug@acme.com", "@doug"), or by name. Several by name are all returned. */
export function whoIs(sql: Sql, who: string): AtlasRecord[] {
  const w = who.trim();
  if (w.includes("@") && /\.[a-z]/i.test(w)) {
    const r = findPerson(sql, "email", w);
    return r ? [r] : [];
  }
  if (/^\+?[\d\s().-]{7,}$/.test(w)) {
    const r = findPerson(sql, "phone", w);
    return r ? [r] : [];
  }
  for (const kind of ["telegram", "github", "linear", "handle"] as const) {
    const r = findPerson(sql, kind, w);
    if (r) return [r];
  }
  const named = recordsNamed(sql, w, 10).filter((r) => r.type === "person" && !r.fields.is_owner);
  const exact = named.filter((r) => r.name.toLowerCase() === w.toLowerCase());
  return exact.length ? exact : named;
}

/** What Atlas knows of a person, for `person` and their page: channels, trust, what's open with them, and the last time in touch. */
export function personInfo(sql: Sql, r: AtlasRecord, tz: string) {
  const tasks = openTasks(sql).filter((t) => {
    const p = fitsOf(t).person;
    return p ? personIn(sql, p, [r.name]) != null || personIn(sql, r.name, [p]) != null : false;
  });
  const loops = openLoops(sql).filter((l) => {
    const d = detailOf(l);
    return d.person === r.id || (d.waiting_on !== "owner" && personIn(sql, d.waiting_on, [r.name]) != null);
  });
  const last = lastTouch(sql, r);
  const { fact, channels: _c, trust: _t, is_owner: _o, ...details } = r.fields;
  return {
    id: r.id,
    name: r.name,
    ...(typeof fact === "string" && fact ? { about: fact } : {}),
    trust: trustOf(r),
    channels: channelsOf(r).map((c) => ({ kind: c.kind, value: c.value, from: c.via })),
    ...(Object.keys(details).length ? { details } : {}),
    open: [
      ...tasks.map((t) => ({ task: t.name, id: t.id })),
      ...loops.map((l) => ({ waiting: l.title, by: shortLocal(new Date(l.due_at), tz), id: l.id })),
    ],
    last_in_touch: last ? { at: shortLocal(new Date(last.at), tz), what: last.what } : null,
  };
}

export const person = defineTool({
  name: "person",
  kind: "look",
  status: "Looking them up.",
  description: [
    "Who someone is, from what you know: how to reach them (addresses, numbers, handles, and where you learned each), how much the owner trusts them, what's open with them (tasks for them, loops waiting on them), and the last time the owner was in touch.",
    "Use it for 'who's Doug?', 'how do I reach Sam?', 'what's open with the landlord?', and before writing to someone, to find their address.",
    "Pass a name, an email address, a number or a handle. With several people by that name, you get each; ask which one if it matters.",
  ].join(" "),
  input: z.object({ who: z.string().min(1).max(120) }),
  async run(input, ctx) {
    const found = whoIs(ctx.sql, input.who);
    if (!found.length)
      return fail(`You don't know anyone as "${input.who}". The owner can tell you, or bring in their contacts in Settings → Extensions.`);
    return { ok: true, output: { people: found.slice(0, 5).map((r) => personInfo(ctx.sql, r, ctx.tz)) } };
  },
});

export const contactSave = defineTool({
  name: "contact_save",
  kind: "change_own",
  status: "Saving their details.",
  description: [
    "Keep how to reach someone, and how much the owner trusts them: when the owner says 'Doug's email is doug@acme.com', 'that's my landlord's number', 'Sam is a client', or when it's clear an address you've seen is someone you know.",
    "Pass the person's id (from person or recall) to change someone you know, or a name to make or find them. Channels are added, never replaced; trust is one of family, friend, colleague, client or unknown.",
    "The owner sees a receipt with Undo.",
  ].join(" "),
  input: z.object({
    id: z.string().max(64).optional(),
    name: z.string().min(1).max(120).optional(),
    add: z
      .array(z.object({ kind: z.enum(CHANNEL_KINDS), value: z.string().min(2).max(200) }))
      .max(10)
      .optional()
      .describe("Ways to reach them: an email, a phone number, or a handle on Telegram, GitHub or Linear."),
    trust: z.enum(TRUST).optional(),
  }),
  async run(input, ctx) {
    const source = { via: ctx.via, run_id: ctx.run_id, ...(ctx.source_log_id ? { log_id: ctx.source_log_id } : {}) };
    const channels: Channel[] = (input.add ?? []).map((c) => ({ ...c, via: "you" }));
    let r = input.id ? getRecord(ctx.sql, input.id) : null;
    if (input.id && (!r || r.type !== "person" || r.state !== "active")) return fail(`There's no person with id ${input.id}.`);
    // The owner's own addresses decide whose mail is the owner speaking: only the owner changes them, in Library.
    if (r?.fields.is_owner) return fail("The owner's own addresses are changed by the owner, in Library → People, not from here.");
    const bad = (input.add ?? []).find((c) => c.kind === "email" && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(c.value.trim()));
    if (bad) return fail(`"${bad.value}" isn't an email address.`);
    if (!r && !input.name) return fail("Say who: their id, or their name.");
    if (!r) {
      const known = whoIs(ctx.sql, input.name!);
      if (known.length > 1)
        return fail(
          `You know ${known.length} people as "${input.name}": ${known.map((k) => `${k.name} (${k.id})`).join(", ")}. Pass the id.`,
        );
      r = known[0] ?? null;
    }
    let history: number | null = null;
    let made = false;
    if (!r) {
      r = upsertPerson(ctx.sql, { name: input.name!, channels, ...(input.trust ? { trust: input.trust } : {}) }, source).record;
      made = true;
    } else {
      if (channels.length) addChannels(ctx.sql, r.id, channels, source, "the owner said");
      if (input.trust && input.trust !== trustOf(getRecord(ctx.sql, r.id)!))
        history = correctRecord(ctx.sql, r.id, { fields: { trust: input.trust } }, "the owner said", source).history_seq;
    }
    const after = getRecord(ctx.sql, r.id)!;
    const said = [...channels.map((c) => c.value), ...(input.trust ? [input.trust] : [])].join(", ");
    return {
      ok: true,
      output: { id: after.id, name: after.name, trust: trustOf(after), channels: channelsOf(after).map((c) => `${c.kind}: ${c.value}`) },
      receipt: {
        text: `${made ? "New person" : "Contact"} · ${after.name}${said ? ` · ${said}` : ""}`,
        undo: made
          ? { kind: "record.forget", id: after.id }
          : { kind: "record.revert", id: after.id, history: history ?? latestHistory(ctx.sql, after.id) },
      },
    };
  },
});

const latestHistory = (sql: Sql, id: string) =>
  sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM record_history WHERE record_id = ?`, id).one().seq;

export const loopOpen = defineTool({
  name: "loop_open",
  kind: "change_own",
  status: "Keeping an eye on that.",
  description: [
    "Keep an open loop: something to hear by a time, so silence becomes news. Use it when the owner asks ('tell me if the landlord hasn't replied by Friday'), after you send something that asks a question, so you notice if no answer comes, and when someone is waiting on the owner (a review requested of them, a question they were asked), so it comes back if it's still open.",
    "waiting_on is who it waits on (their name or address), or 'owner' for something someone is waiting on the owner for. Mail or a message from them (or in `thread`) closes it by itself; if nothing comes by `by`, it comes back to you then, once.",
    "The owner sees it in Agenda, with a receipt and Undo.",
  ].join(" "),
  input: z.object({
    about: z.string().min(1).max(160).describe("What it's about, in a few words: 'the lease renewal'."),
    waiting_on: z.string().min(1).max(160),
    by: z.string().describe("When it's news if nothing came: a local date-time YYYY-MM-DDTHH:mm."),
    thread: z.string().max(200).optional().describe("The mail thread or issue an answer would come in, when you know it."),
  }),
  async run(input, ctx) {
    const due = parseWhen(input.by, ctx.tz);
    if (!due) return fail(`Couldn't read "${input.by}". Use YYYY-MM-DDTHH:mm.`);
    if (due.getTime() <= Date.now()) return fail("That time has passed; pick one ahead.");
    const who = input.waiting_on.toLowerCase() === "owner" ? null : (whoIs(ctx.sql, input.waiting_on)[0] ?? null);
    const loop = openLoop(ctx.sql, {
      about: input.about,
      waiting_on: input.waiting_on.toLowerCase() === "owner" ? "owner" : input.waiting_on,
      ...(who ? { person: who.id } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      opened_by: ctx.via === "clock" ? "atlas" : "owner",
      due_at: due.getTime(),
      run_id: ctx.run_id,
      log_id: ctx.source_log_id,
      via: ctx.via,
    });
    await ctx.clock.schedule(loop);
    return {
      ok: true,
      output: { id: loop.id, waiting: loop.title, by: isoLocal(due, ctx.tz) },
      receipt: { text: `Waiting · ${loop.title} · by ${shortLocal(due, ctx.tz)}`, undo: { kind: "reminder.cancel", id: loop.id } },
    };
  },
});

export const loopClose = defineTool({
  name: "loop_close",
  kind: "change_own",
  status: "Closing that out.",
  description:
    "Close an open loop that's settled another way (the owner heard by phone, or doesn't need it now). Its id is in the open loops in your context.",
  input: z.object({ id: z.string().max(64), why: z.string().max(200).default("Settled.") }),
  async run(input, ctx) {
    const closed = closeLoop(ctx.sql, input.id, input.why, { by: ctx.via === "clock" ? "atlas" : "owner", run_id: ctx.run_id });
    if (!closed) return fail(`There's no open loop with id ${input.id}.`);
    await ctx.clock.unschedule(closed);
    return { ok: true, output: { closed: closed.title }, receipt: { text: `Closed · ${closed.title}` } };
  },
});

export const peopleTools = [person, contactSave, loopOpen, loopClose];
