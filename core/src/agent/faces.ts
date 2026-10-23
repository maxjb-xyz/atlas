// The face desk (VISION §7.2): someone who isn't the owner writes to
// Atlas on a channel or at its address, and the face for them answers.
// Each message in and out is a row in the log (face.in, face.out); what the
// face hands the owner (a message, a pull-in) is a row Inbox shows, with a
// push when it's urgent, and the owner's answer from Inbox goes back
// through the face. A digest of the day's conversations goes to Inbox.

import { type Face, faceFor, faces, getFace, reachOf } from "../faces";
import type { Installed } from "../extensions";
import type { Message } from "../../../extensions/sdk";
import type { Sql } from "../store/db";
import { append, type LogRow } from "../store/log";
import { getRecord } from "../store/records";

export interface FaceDeps {
  sql: Sql;
  /** Runs the face on a conversation: its prompt, its tools, the conversation so far. Returns what it says. */
  run(o: { face: Face; conv: string; from: string; person: string | null; note: string | null; test?: boolean }): Promise<string>;
  /** Sends the face's words out on the address the conversation is on. */
  send(o: { conv: string; where: Where; text: string; face: Face }): Promise<void>;
  /** Tells the owner, on one device, when something can't wait. */
  push(text: string, row: LogRow): Promise<void>;
  /** Inbox changed. */
  changed(): void;
}

/** Where a conversation is: a chat on a channel, or a mail thread at Atlas's address. */
export type Where =
  { kind: "chat"; ext: string; chat: string } | { kind: "mail"; to: string; subject: string; message_id?: string; references?: string[] };

export class FaceDesk {
  constructor(private readonly d: FaceDeps) {}

  /** A message on a chat channel from someone who isn't the owner. False when no face on that channel is for them. */
  async take(o: { ext: Installed; msg: Message; text: string; note: string | null }): Promise<boolean> {
    const m = o.msg;
    const hit = faceFor(this.d.sql, o.ext.id, { kind: "telegram", value: m.from.handle ?? m.from.id });
    if (!hit) return false;
    const from = m.from.name
      ? `${m.from.name}${m.from.handle ? ` (@${m.from.handle})` : ""}`
      : m.from.handle
        ? `@${m.from.handle}`
        : m.from.id;
    await this.#converse(hit.face, {
      conv: `${o.ext.id}:${m.chat}`,
      where: { kind: "chat", ext: o.ext.id, chat: m.chat },
      from,
      person: hit.person,
      text: o.text || "(sent something with no words)",
      note: o.note,
      channel: o.ext.name,
    });
    return true;
  }

  /** A mail to Atlas's address from someone else. False when no face on mail is for them. */
  async mail(o: {
    from: string;
    address: string;
    subject: string;
    text: string;
    thread: string;
    message_id?: string;
    references?: string[];
  }): Promise<boolean> {
    const hit = faceFor(this.d.sql, "email", { kind: "email", value: o.address });
    if (!hit) return false;
    await this.#converse(hit.face, {
      conv: o.thread,
      where: {
        kind: "mail",
        to: o.address,
        subject: /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject || "your message"}`,
        ...(o.message_id ? { message_id: o.message_id } : {}),
        ...(o.references ? { references: o.references } : {}),
      },
      from: o.from,
      person: hit.person,
      text: `${o.subject ? `(Subject: ${o.subject})\n` : ""}${o.text}`,
      note: null,
      channel: "email",
    });
    return true;
  }

  /** "Talk to it as a stranger" (§7.2): the face answers in a test conversation that sees only what it would. */
  async test(faceId: string, conv: string, text: string): Promise<{ ok: boolean; text: string }> {
    const face = getFace(this.d.sql, faceId);
    if (!face) return { ok: false, text: "That face isn't there any more." };
    const c = `test:${conv.slice(0, 40)}`;
    append(this.d.sql, { actor: "owner", kind: "face.in", body: { face: face.id, conv: c, from: "You, as a stranger", text, test: true } });
    try {
      const said = await this.d.run({ face, conv: c, from: "a stranger (the owner testing)", person: null, note: null, test: true });
      append(this.d.sql, { actor: "atlas", kind: "face.out", body: { face: face.id, conv: c, text: said, test: true } });
      return { ok: true, text: said };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  async #converse(
    face: Face,
    o: { conv: string; where: Where; from: string; person: string | null; text: string; note: string | null; channel: string },
  ): Promise<void> {
    append(this.d.sql, {
      actor: "system",
      kind: "face.in",
      body: {
        face: face.id,
        conv: o.conv,
        from: o.from,
        ...(o.person ? { person: o.person } : {}),
        text: o.text.slice(0, 8_000),
        channel: o.channel,
        where: o.where as never,
      },
    });
    // A person the owner named always pulls them in, whatever the face makes of it.
    if (face.pulls.includes("people") && o.person && face.pull_people.includes(o.person))
      await this.pull(face, { conv: o.conv, from: o.from, person: o.person, kind: "handoff", text: `${o.from} wrote.`, urgent: true });
    let said: string;
    try {
      said = await this.d.run({ face, conv: o.conv, from: o.from, person: o.person, note: o.note });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await this.pull(face, {
        conv: o.conv,
        from: o.from,
        person: o.person,
        kind: "handoff",
        text: `${face.name} couldn't answer: ${why}`,
        urgent: false,
      });
      return;
    }
    if (!said.trim()) return;
    append(this.d.sql, { actor: "atlas", kind: "face.out", body: { face: face.id, conv: o.conv, text: said, channel: o.channel } });
    await this.d.send({ conv: o.conv, where: o.where, text: said, face });
  }

  /** Something for the owner from a face: a message or a pull-in, in Inbox, pushed when urgent. */
  async pull(
    face: Face,
    o: {
      conv: string;
      from: string;
      person: string | null;
      kind: "message" | "handoff";
      text: string;
      urgent: boolean;
      details?: Record<string, string>;
    },
  ): Promise<void> {
    const row = append(this.d.sql, {
      actor: "atlas",
      kind: "face.handoff",
      body: {
        face: face.id,
        face_name: face.name,
        conv: o.conv,
        from: o.from,
        ...(o.person ? { person: o.person, reach: reachOf(this.d.sql, o.person) } : {}),
        kind: o.kind,
        text: o.text.slice(0, 2_000),
        urgent: o.urgent,
        ...(o.details ? { details: o.details } : {}),
      },
    });
    this.d.changed();
    if (o.urgent) await this.d.push(`${face.name}: ${o.from}: ${o.text}`.slice(0, 300), row);
  }

  /** The owner's answer from Inbox, sent through the face in the conversation it came from. */
  async answer(handoffId: string, text: string): Promise<{ ok: boolean; text: string }> {
    const h = this.d.sql.exec<{ body: string }>(`SELECT body FROM log WHERE id = ? AND kind = 'face.handoff'`, handoffId).toArray()[0];
    if (!h) return { ok: false, text: "That isn't there any more." };
    const b = JSON.parse(h.body) as { face: string; conv: string };
    const face = getFace(this.d.sql, b.face);
    const first = this.d.sql
      .exec<{ body: string }>(
        `SELECT body FROM log WHERE kind = 'face.in' AND json_extract(body, '$.conv') = ? AND json_extract(body, '$.where') IS NOT NULL ORDER BY seq DESC LIMIT 1`,
        b.conv,
      )
      .toArray()[0];
    if (!face || !first) return { ok: false, text: "That conversation can't be answered from here any more." };
    const where = (JSON.parse(first.body) as { where: Where }).where;
    append(this.d.sql, { actor: "owner", kind: "face.out", body: { face: face.id, conv: b.conv, text, by: "owner", answers: handoffId } });
    await this.d.send({ conv: b.conv, where, text, face });
    this.d.changed();
    return { ok: true, text: "Sent." };
  }

  /** The day's conversations, per face with a digest, for Inbox. Nothing when nothing happened. */
  digest(now = Date.now()): LogRow[] {
    const since = now - 86_400_000;
    const out: LogRow[] = [];
    for (const f of faces(this.d.sql).filter((x) => x.on && x.digest === "daily")) {
      const rows = this.d.sql
        .exec<{ body: string }>(
          `SELECT body FROM log WHERE kind = 'face.in' AND at > ? AND json_extract(body, '$.face') = ? AND json_extract(body, '$.test') IS NULL ORDER BY seq`,
          since,
          f.id,
        )
        .toArray()
        .map((r) => JSON.parse(r.body) as { conv: string; from: string; text: string; person?: string });
      if (!rows.length) continue;
      const convs = new Map<string, { from: string; n: number; last: string }>();
      for (const r of rows) {
        const c = convs.get(r.conv) ?? { from: r.person ? (getRecord(this.d.sql, r.person)?.name ?? r.from) : r.from, n: 0, last: "" };
        c.n++;
        c.last = r.text;
        convs.set(r.conv, c);
      }
      const handoffs = this.d.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM log WHERE kind = 'face.handoff' AND at > ? AND json_extract(body, '$.face') = ?`,
          since,
          f.id,
        )
        .one().n;
      const text = [
        `${convs.size} conversation${convs.size === 1 ? "" : "s"} today${handoffs ? `, ${handoffs} handed to you` : ""}:`,
        ...[...convs.values()].map((c) => `- ${c.from}: ${c.n} message${c.n === 1 ? "" : "s"}, last "${c.last.slice(0, 160)}"`),
      ].join("\n");
      out.push(
        append(this.d.sql, {
          actor: "atlas",
          kind: "face.digest",
          body: { face: f.id, face_name: f.name, text, conversations: convs.size },
        }),
      );
    }
    if (out.length) this.d.changed();
    return out;
  }
}
