// Undo from a receipt (§12.1, §21.1). Each undo writes its own log row that
// points back at the receipt (`undo_of`), so the thread and History show
// what was undone, and the same receipt can't be undone twice.

import { finish, getItem } from "../store/agenda";
import type { Sql } from "../store/db";
import { get as getRow, type LogRow, type Receipt } from "../store/log";
import { forgetRecord, getRecord, restoreRecord, revertRecord } from "../store/records";
import type { ToolContext } from "../tools/types";
import { deletePage, getPage, pageVersion, savePage } from "../pages";

export type UndoOutcome = { ok: true; row: LogRow; agenda: boolean } | { ok: false; message: string };

export async function undoReceipt(sql: Sql, logId: string, clock: ToolContext["clock"]): Promise<UndoOutcome> {
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
      `SELECT id FROM log WHERE kind IN ('agenda.change', 'record.change', 'page.change') AND json_extract(body, '$.undo_of') = ? LIMIT 1`,
      logId,
    )
    .toArray()[0];
  return r ? getRow(sql, r.id) : null;
}
