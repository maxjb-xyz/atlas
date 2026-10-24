// Undo from a receipt (§12.1, §21.1). Each undo writes its own log row that
// points back at the receipt (`undo_of`), so the thread and History show
// what was undone, and the same receipt can't be undone twice.

import { getSkill, restoreSkill, setSkillState } from "../skills";
import { finish, getItem } from "../store/agenda";
import type { Sql } from "../store/db";
import { append, get as getRow, type LogRow, type Receipt } from "../store/log";
import { SettingsPatch, writeSettings } from "../store/settings";
import { forgetRecord, getRecord, restoreRecord, revertRecord } from "../store/records";
import type { ToolContext } from "../tools/types";
import { deletePage, getPage, pageVersion, savePage } from "../pages";

export type UndoOutcome = { ok: true; row: LogRow; agenda: boolean } | { ok: false; message: string };

export async function undoReceipt(
  sql: Sql,
  logId: string,
  clock: ToolContext["clock"],
  calendar: ToolContext["calendar"] = null,
): Promise<UndoOutcome> {
  const receiptRow = getRow(sql, logId);
  const undo = (receiptRow?.body.receipt as Receipt | undefined)?.undo;
  if (!receiptRow || !undo) return { ok: false, message: "There's nothing to undo there." };
  if (undoneBy(sql, logId)) return { ok: false, message: "That's already undone." };
  const by = { via: "owner", run_id: receiptRow.run_id ?? undefined };
  const mark = { by: "owner", undo_of: logId };

  switch (undo.kind) {
    case "reminder.cancel": {
      const item = getItem(sql, undo.id);
      if (!item || item.state !== "scheduled") {
        return {
          ok: false,
          message: `That ${item?.kind === "promise" ? "promise was already kept" : "reminder already went off"} or was cancelled.`,
        };
      }
      await clock.unschedule(item);
      finish(sql, item.id, "cancelled", receiptRow.run_id, mark);
      return { ok: true, row: undoneBy(sql, logId)!, agenda: true };
    }
    case "record.forget":
    case "record.restore":
    case "record.revert": {
      const rec = getRecord(sql, undo.id);
      if (!rec) return { ok: false, message: "That record no longer exists." };
      const done =
        undo.kind === "record.forget"
          ? forgetRecord(sql, rec.id, by, mark)
          : undo.kind === "record.restore"
            ? restoreRecord(sql, rec.id, by, mark)
            : revertRecord(sql, rec.id, undo.history, by, mark);
      if (!done) {
        return {
          ok: false,
          message:
            undo.kind === "record.restore"
              ? `${rec.name} isn't forgotten anymore.`
              : `${rec.name} was changed or forgotten since, so undoing this would lose that. Change it again instead.`,
        };
      }
      return { ok: true, row: undoneBy(sql, logId)!, agenda: false };
    }
    case "skill.undo": {
      const s = getSkill(sql, undo.id);
      if (!s) return { ok: false, message: "That skill isn't there any more." };
      if (s.version !== undo.version)
        return { ok: false, message: `${s.name} was changed since, so undoing this would lose that. Change it again instead.` };
      const row =
        undo.version === 1
          ? setSkillState(sql, s.id, "archived", "owner", "Undone.")
          : restoreSkill(sql, s.id, undo.version - 1, "owner", `Undid version ${undo.version}.`);
      return row ? { ok: true, row, agenda: false } : { ok: false, message: "There was nothing to undo." };
    }
    case "skill.restore": {
      const s = getSkill(sql, undo.id);
      if (!s) return { ok: false, message: "That skill isn't there any more." };
      const row = setSkillState(sql, s.id, "active", "owner", "Brought back.");
      return row ? { ok: true, row, agenda: false } : { ok: false, message: `${s.name} is already in use.` };
    }
    case "calendar.move": {
      if (!calendar?.move) return { ok: false, message: "The calendar isn't connected now, so the event can't be moved back from here." };
      try {
        await calendar.move(undo.id, { start: undo.start, end: undo.end });
      } catch (err) {
        return { ok: false, message: `Couldn't move ${undo.title} back: ${err instanceof Error ? err.message : String(err)}` };
      }
      const row = append(sql, {
        actor: "owner",
        kind: "calendar.change",
        body: { change: "moved", id: undo.id, title: undo.title, start: undo.start, end: undo.end, ...mark },
      });
      return { ok: true, row, agenda: false };
    }
    case "speaking.restore": {
      const before = SettingsPatch.shape.speaking.safeParse(undo.before);
      if (!before.success || !before.data) return { ok: false, message: "That change to Speaking up can't be undone from here." };
      writeSettings(sql, { speaking: before.data });
      const row = append(sql, { actor: "owner", kind: "settings.change", body: { keys: ["speaking"], ...mark } });
      return { ok: true, row, agenda: false };
    }
    case "page.undo": {
      const p = getPage(sql, undo.id);
      if (!p) return { ok: false, message: "That page was deleted." };
      if (p.version !== undo.version)
        return { ok: false, message: `${p.name} was changed since, so undoing this would lose that. Change it again instead.` };
      if (undo.version === 1) return { ok: true, row: deletePage(sql, p.id, "owner", logId)!, agenda: false };
      const before = pageVersion(sql, p.id, undo.version - 1)!;
      const out = savePage(sql, {
        id: p.id,
        name: p.name,
        body: before.body,
        note: `Undid version ${undo.version}`,
        by: "owner",
        undo_of: logId,
      });
      return out.row ? { ok: true, row: out.row, agenda: false } : { ok: false, message: "There was nothing to undo." };
    }
  }
}

/** The row that undid this receipt, if it was undone. */
function undoneBy(sql: Sql, logId: string): LogRow | null {
  const r = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE kind IN ('agenda.change', 'record.change', 'page.change', 'settings.change', 'calendar.change') AND json_extract(body, '$.undo_of') = ? LIMIT 1`,
      logId,
    )
    .toArray()[0];
  return r ? getRow(sql, r.id) : null;
}
