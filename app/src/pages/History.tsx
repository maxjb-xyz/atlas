// History (§4.2, §21.2): the log. What Atlas, helpers and the clock did,
// each opening into its receipt: who asked, what changed, the brain, tokens,
// and Undo. Append-only and kept forever.

import { useEffect, useState } from "react";
import type { HistoryFilter, LogRow } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Markdown } from "../Markdown";
import { Composer } from "../Shell";
import { AreaChip, clock, dayName, Diamond, Empty, pressable, Sheet, Stage, startOfDay } from "../ui";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

function describe(r: LogRow): { who: string; what: string; kind: string } {
  const b = r.body as Record<string, unknown>;
  switch (r.kind) {
    case "message.in":
      return { who: `You · ${r.surface === "voice" ? "voice" : "chat"}`, what: `“${str(b.text)}”`, kind: "chat.turn" };
    case "message.out":
      return { who: "Atlas", what: str(b.text), kind: "chat.reply" };
    case "tool.result":
      return { who: "Atlas", what: str((b.receipt as { text?: string })?.text), kind: str(b.name) };
    case "record.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what: `${b.change === "created" ? "Learned" : b.change === "forgotten" ? "Forgot" : b.change === "restored" ? "Remembered again" : "Corrected"}: ${str(b.name)}`,
        kind: `record.${str(b.change)}`,
      };
    case "agenda.change":
      if (b.kind === "approval") {
        const what =
          b.change === "created"
            ? `Asked for your OK: ${str(b.title)}`
            : b.change === "done"
              ? `You OK'd ${str(b.title)}${b.edited ? ", with edits" : ""}`
              : b.change === "cancelled"
                ? `You declined ${str(b.title)}`
                : `Your OK for ${str(b.title)} ran out`;
        return { who: b.change === "created" || b.change === "failed" ? "Atlas" : "You", what, kind: `approval.${str(b.change)}` };
      }
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what: `${str(b.kind) === "job" ? "Job" : str(b.kind) === "promise" ? "Promise" : "Reminder"} ${str(b.change) === "done" && str(b.kind) === "promise" ? "kept" : str(b.change)}: ${str(b.title)}`,
        kind: `${str(b.kind)}.${str(b.change)}`,
      };
    case "area.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what:
          b.change === "moved"
            ? `Moved something to other areas`
            : `${b.change === "started" ? "Started" : b.change === "created" ? "Added" : "Changed"} the area ${str(b.name)}`,
        kind: `area.${str(b.change)}`,
      };
    case "job.result":
      return {
        who: `Helper · ${str(b.title)}`,
        what: b.state === "done" ? `Finished: ${str(b.text).slice(0, 140)}` : `Didn't finish: ${str(b.error)}`,
        kind: "job.result",
      };
    case "run.end":
      return { who: "Atlas", what: `Didn't finish: ${str(b.error)}`, kind: "run.failed" };
    case "brain.fallback":
      return { who: "Atlas", what: `Answered with ${str(b.to)} because ${str(b.from)} failed`, kind: "brain.fallback" };
    case "context.summary":
      return {
        who: "Atlas",
        what: `Summarized ${str(b.messages)} older messages to keep the conversation in view`,
        kind: "context.summary",
      };
    case "automation.run": {
      const first = str(b.text).split("\n")[0]!.slice(0, 140);
      const what = b.quiet
        ? `Looked: ${first}`
        : b.test
          ? `Test run, sent nothing: ${b.ok === false ? str(b.error) : first}`
          : b.ok === false
            ? `Didn't run: ${str(b.error)}`
            : `Ran${b.brain ? "" : ", no brain"}: ${first}`;
      return { who: `Automation · ${str(b.name)}`, what, kind: `automation.${str(b.why)}` };
    }
    case "automation.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what: `${{ made: "Made", changed: "Changed", on: "Turned on", paused: "Paused", deleted: "Deleted" }[str(b.change)] ?? "Changed"} the automation ${str(b.name)}${b.why ? `: ${str(b.why)}` : ""}`,
        kind: `automation.${str(b.change)}`,
      };
    case "page.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what:
          b.change === "deleted"
            ? `Deleted the page ${str(b.name)}`
            : `${b.change === "made" ? "Made" : `Version ${str(b.version)} of`} the page ${str(b.name)}${b.note && b.change !== "made" ? `: ${str(b.note)}` : ""}`,
        kind: `page.${str(b.change)}`,
      };
    case "skill.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what:
          b.change === "made"
            ? `Learned a skill: ${str(b.name)}`
            : b.change === "patched"
              ? `Version ${str(b.version)} of the skill ${str(b.name)}${b.note ? `: ${str(b.note)}` : ""}`
              : b.change === "archived"
                ? `Archived the skill ${str(b.name)}${b.note ? `: ${str(b.note)}` : ""}`
                : `Brought back the skill ${str(b.name)}`,
        kind: `skill.${str(b.change)}`,
      };
    case "file.change":
      return {
        who: r.actor === "owner" ? "You" : "Atlas",
        what: `${{ made: "Made", replaced: "Replaced", deleted: "Deleted" }[str(b.change)] ?? "Changed"} the file ${str(b.name)}`,
        kind: `file.${str(b.change)}`,
      };
    case "delivery": {
      const where =
        b.channel === "push"
          ? `Notification${b.to ? ` to ${str(b.to)}` : ""}`
          : b.channel === "webhook"
            ? `Called ${str(b.to)}`
            : b.channel === "web"
              ? b.what === "search"
                ? `Searched ${str(b.to)} for “${str(b.text)}”`
                : b.what === "browse"
                  ? `Opened ${str(b.text)} in the browser`
                  : b.what === "type"
                    ? `Typed “${str(b.text)}” on ${str(b.to)}`
                    : `Read ${str(b.text)}`
              : b.channel === "browser"
                ? `Sent a form on ${str(b.to)}: ${str(b.text)}`
                : b.channel === "vault"
                  ? `Filled in ${str(b.text)} on ${str(b.to)}${b.pressed ? `, then pressed “${str(b.pressed)}”` : ""}`
                  : b.channel === "mcp"
                    ? b.what === "connect"
                      ? `${b.ok === false ? "Tried to connect" : "Connected"} ${str(b.to)} (${str(b.text)})`
                      : `Used ${str(b.text)} on ${str(b.to)}`
                    : `${str(b.channel)}${b.to ? ` · ${str(b.to)}` : ""}`;
      const what =
        b.ok === false
          ? `${where}, but it didn't work: ${str(b.error)}`
          : b.note
            ? `${where}: ${str(b.note)}`
            : b.answer
              ? `${where}: ${str(b.answer)}`
              : b.channel === "web" || b.channel === "browser" || b.channel === "vault" || b.channel === "mcp"
                ? where
                : `${where}${b.text ? `: “${str(b.text)}”` : ""}`;
      return { who: b.by === "owner" ? "You" : "Atlas", what, kind: `deliver.${str(b.channel)}` };
    }
    case "settings.change": {
      const what = Array.isArray(b.keys)
        ? `Changed ${(b.keys as string[]).map((k) => k.replace(/_/g, " ")).join(", ")}`
        : b.secret
          ? `${b.set ? "Set" : "Cleared"} ${str(b.secret).replace(/_/g, " ")}`
          : b.chatgpt
            ? `ChatGPT: ${str(b.chatgpt).replace(/_/g, " ")}`
            : b.icloud
              ? `iCloud ${str(b.icloud)}: ${str(b.message)}`
              : b.passkeys != null
                ? `Passkeys: ${str(b.passkeys)}`
                : b.push
                  ? `Notifications ${str(b.push)}: ${str(b.name)}`
                  : b.webhook
                    ? `Webhook ${str(b.webhook)}: ${str(b.name)}`
                    : b.vault
                      ? `Vault: ${str(b.name)} ${str(b.vault)}`
                      : b.workspace
                        ? b.workspace === "restarted"
                          ? "Restarted the workspace"
                          : `Workspace: ${str(b.workspace)}${b.name ? ` (${str(b.name)})` : ""}`
                        : b.mcp
                          ? `${b.mcp === "added" ? "Added" : "Removed"} the MCP server ${str(b.name)} (${str(b.url)})`
                          : b.trust
                            ? `Trust ${str(b.trust)}${b.name ? `: ${str(b.name)}` : ""}`
                            : b.focus
                              ? b.focus === "on"
                                ? `Focus until ${new Date(Number(b.until)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${b.about ? `: ${str(b.about)}` : ""}`
                                : "Ended focus"
                              : "Changed settings";
      return { who: r.actor === "owner" ? "You" : "Atlas", what, kind: "settings.change" };
    }
    default:
      return { who: r.actor, what: r.kind, kind: r.kind };
  }
}

export function History({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  const [filter, setFilter] = useState<HistoryFilter>("everything");
  const [open, setOpen] = useState<string | null>(null);
  const dayStart = startOfDay(new Date()).getTime();
  const ask = (before?: number) =>
    atlas.send({ type: "atlas.history", filter, area: s.scope, day_start: dayStart, ...(before != null ? { before_seq: before } : {}) });
  useEffect(() => {
    if (atlas.voice.connected) ask();
  }, [filter, s.scope, atlas.voice.connected, s.rows.length]);

  const h = s.history?.filter === filter ? s.history : null;
  const rows = h?.rows ?? [];
  const stats = h?.stats;
  const max = Math.max(1, ...(stats?.per_hour ?? [0]));
  const hourNow = new Date().getHours();
  const byDay = new Map<string, LogRow[]>();
  for (const r of rows)
    byDay.set(startOfDay(new Date(r.at)).toDateString(), [...(byDay.get(startOfDay(new Date(r.at)).toDateString()) ?? []), r]);

  return (
    <Stage
      label="History"
      tabs={[
        { id: "everything", label: "Everything" },
        { id: "actions", label: "Actions" },
        { id: "conversations", label: "Conversations" },
        { id: "jobs", label: "Jobs" },
      ]}
      tab={filter}
      onTab={(f) => {
        setFilter(f);
        setOpen(null);
      }}
      meta="Append-only · kept forever"
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Ask what happened, or undo something" />
        </div>
      }
    >
      <Sheet>
        <div className="sheet-in">
          <div className="sheet-title">
            <h1 className="disp">What happened</h1>
            <span className="muted">Today so far, {dayName(new Date())}</span>
          </div>
          {stats && (
            <div className="row" style={{ gap: 0, border: "1px solid var(--sep)", marginBottom: 18, alignItems: "stretch" }}>
              {(
                [
                  ["Actions", stats.actions],
                  ["Conversations", stats.conversations],
                  ["Jobs", stats.jobs],
                  ["Tokens", stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1)}k` : stats.tokens],
                ] as Array<[string, number | string]>
              ).map(([k, v]) => (
                <div key={k} style={{ padding: "10px 16px", borderRight: "1px solid var(--sep)", minWidth: 110 }}>
                  <p className="lab">{k}</p>
                  <p className="disp" style={{ fontSize: 22 }}>
                    {v}
                  </p>
                </div>
              ))}
              <div
                className="grow hide-phone"
                style={{ padding: "10px 16px", display: "flex", alignItems: "flex-end", gap: 4 }}
                aria-hidden
              >
                {stats.per_hour.map((n, i) => (
                  <i
                    key={i}
                    style={{
                      display: "block",
                      flex: 1,
                      height: 3 + (n / max) * 26,
                      background: i === hourNow ? "var(--tx)" : n ? "var(--tx3)" : "var(--sep2)",
                      opacity: i > hourNow ? 0.4 : 1,
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          {!rows.length && h && <Empty title="Nothing here yet">What Atlas does shows here, each with its receipt.</Empty>}
          {[...byDay].map(([day, list]) => (
            <div key={day}>
              <div className="section-rule">
                <span className="lab">
                  {day === new Date().toDateString() ? "Today" : dayName(new Date(day))} / {list.length}{" "}
                  {list.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <div className="rows">
                {list.map((r) => (
                  <Entry key={r.id} atlas={atlas} row={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                ))}
              </div>
            </div>
          ))}
          {h?.has_more && rows.length > 0 && (
            <p style={{ marginTop: 14 }}>
              <button className="link" onClick={() => ask(rows[rows.length - 1]!.seq)}>
                Show earlier
              </button>
            </p>
          )}
        </div>
      </Sheet>
    </Stage>
  );
}

function Entry({ atlas, row, open, onToggle }: { atlas: Atlas; row: LogRow; open: boolean; onToggle: () => void }) {
  const s = atlas.state;
  const d = describe(row);
  const receipt = row.body.receipt as { text?: string; undo?: unknown } | undefined;
  // The undo may be older than the thread holds; History's own rows have it too.
  const undone = s.rows.some((r) => r.body.undo_of === row.id) || Boolean(s.history?.rows.some((r) => r.body.undo_of === row.id));
  useEffect(() => {
    if (open && row.run_id) atlas.send({ type: "atlas.run.detail", run_id: row.run_id });
  }, [open]);
  const detail = row.run_id ? s.runDetail[row.run_id] : undefined;
  const run = detail?.run as
    | { trigger?: string; state?: string; steps?: number; detail?: { brain?: string; usage?: { input?: number; output?: number } } }
    | undefined;
  const asked = detail?.rows.find((r) => r.kind === "message.in");
  const calls = detail?.rows.filter((r) => r.kind === "tool.call") ?? [];

  return (
    <div
      className="r"
      style={{
        flexDirection: "column",
        alignItems: "stretch",
        gap: 10,
        borderLeft: open ? "2px solid var(--tx)" : undefined,
        paddingLeft: open ? 10 : 0,
      }}
    >
      <div className="row" style={{ flexWrap: "nowrap", cursor: "pointer" }} {...pressable(onToggle)} aria-expanded={open}>
        <span className="mono faint small" style={{ width: 64, flex: "none" }}>
          {clock(row.at)}
        </span>
        <span className="row hide-phone" style={{ width: 170, flex: "none", gap: 8, flexWrap: "nowrap" }}>
          {d.who.startsWith("You") ? <span className="avatar">Me</span> : <Diamond size={14} />}
          <span className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {d.who}
          </span>
        </span>
        <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.what}
        </span>
        <span className="hide-phone">
          <AreaChip ids={row.areas} areas={s.areas} />
        </span>
        <span className="mono faint small hide-phone" style={{ width: 130, textAlign: "right" }}>
          {d.kind}
        </span>
        <span style={{ width: 60, textAlign: "right" }}>
          {receipt?.undo != null && !undone ? (
            <button
              className="btn sm"
              onClick={(e) => {
                e.stopPropagation();
                atlas.send({ type: "atlas.undo", log_id: row.id });
              }}
            >
              Undo
            </button>
          ) : undone ? (
            <span className="lab">Undone</span>
          ) : null}
        </span>
      </div>
      {open && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="chain">
            <span className="tag">{asked ? `You · ${asked.surface === "voice" ? "voice" : "chat"}` : (run?.trigger ?? "Atlas")}</span>
            <span className="dash" />
            <span className="tag">Atlas</span>
            {calls.map((c) => (
              <span key={c.id} style={{ display: "contents" }}>
                <span className="dash" />
                <span className="tag ok">✓ {str(c.body.name)}</span>
              </span>
            ))}
          </div>
          <div className="panel kv">
            <span className="lab">Asked by</span>
            <span className="mono small">{asked ? `You · ${clock(asked.at)} · “${str(asked.body.text)}”` : (run?.trigger ?? "Atlas")}</span>
            <span className="lab">What happened</span>
            <span className="small" style={{ whiteSpace: "pre-wrap" }}>
              {row.kind === "record.change" && row.body.before ? (
                `${JSON.stringify(row.body.before)} → ${JSON.stringify(row.body.after)}`
              ) : row.kind === "message.out" ? (
                <Markdown text={str(row.body.text)} />
              ) : row.kind === "message.in" ? (
                str(row.body.text)
              ) : (
                d.what
              )}
            </span>
            {run?.detail?.brain && (
              <>
                <span className="lab">Brain</span>
                <span className="mono small">
                  {run.detail.brain}
                  {run.detail.usage ? ` · ${(run.detail.usage.input ?? 0) + (run.detail.usage.output ?? 0)} tokens` : ""}
                </span>
              </>
            )}
            <span className="lab">Undo</span>
            <span className="mono small">{receipt?.undo != null ? (undone ? "Done" : "Available") : "Nothing to undo"}</span>
            {row.run_id && (
              <>
                <span className="lab">Run</span>
                <span className="mono small">
                  {row.run_id}
                  {run?.state ? ` · ${run.state}` : ""}
                  {run?.steps != null ? ` · ${run.steps} steps` : ""}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
