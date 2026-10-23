// Approvals (VISION §12). The kind of action decides when Atlas asks, and
// that rule is this code, not the model's judgment. An action that needs the
// owner's OK waits as one card per run (one approval per plan); the card is
// an agenda item on the one clock, so it expires on time and says what
// didn't happen. After five approvals of the same outside action as-is,
// Atlas offers to stop asking for it.

import { createItem, type AgendaItem, getItem } from "./store/agenda";
import type { Json, Sql } from "./store/db";
import { getState, setState } from "./store/state";

/**
 * What kind of action a tool takes, which decides when Atlas asks first
 * (§12.1): looking, changing the owner's own things (undoable), reaching
 * outside Atlas, or something that can't be undone.
 */
export type ToolKind = "look" | "change_own" | "outside" | "irreversible";

/** When each kind of action asks first (§12.1). The Permissions page shows this table. */
export const ASKS: Record<ToolKind, { asks: "never" | "until_trusted" | "always"; hold: boolean; why: string }> = {
  look: { asks: "never", hold: false, why: "Looking at your own things and the web changes nothing." },
  change_own: {
    asks: "never",
    hold: false,
    why: "Changes to your own things can be undone, so Atlas does them, tells you, and offers Undo.",
  },
  outside: {
    asks: "until_trusted",
    hold: false,
    why: "It reaches beyond Atlas and can't be taken back. After you've approved the same one five times as-is, Atlas offers to stop asking.",
  },
  irreversible: { asks: "always", hold: true, why: "It can't be undone, so it always asks, and takes hold to confirm." },
};

/** Something Atlas will do once the owner says yes. Executed by the outbox (§4.4), never by the tool that asked. */
export type Action =
  | { kind: "webhook"; webhook: string; name: string; message?: string }
  | { kind: "delete"; record: string; name: string; fact: string }
  /** Sending a form in the browser (§9.1): pressing its button, or Enter in its field, on the page it was asked on. */
  | { kind: "browser"; ref: string; name: string; url: string; what: string }
  /**
   * Filling a vault entry into the browser's fields (§15), and pressing
   * `press` after (a login's Sign in). `fields` maps the entry's field to the
   * element's number.
   */
  | {
      kind: "vault";
      entry: string;
      name: string;
      host: string;
      url: string;
      card: boolean;
      fields: Record<string, string>;
      press?: { ref: string; text: string };
    }
  /** Letting the workspace reach a website (§9.1), asked once per site and remembered; `key` is a vault key it will carry there. */
  | { kind: "site"; host: string; name: string; why: string; key?: { entry: string; name: string } }
  /**
   * A tool on a connected MCP server that does more than read (§9.2). `name`
   * says it for the card ("create_issue on GitHub"); `destructive` is the
   * server's own word that it can't be undone.
   */
  | {
      kind: "mcp";
      server: string;
      name: string;
      tool: string;
      arguments: Record<string, Json>;
      destructive: boolean;
      what: string;
      /** The server's name and host, for the card. */
      where: string;
    }
  /** Connecting a new MCP server (§9.2: growing its own abilities, with the owner's OK). */
  | { kind: "mcp_add"; name: string; url: string; why: string }
  /**
   * A tool on a paired device that does more than notify (§16.3), such as
   * running a command on the owner's Mac. `name` says it for the card;
   * `what` is the input in words.
   */
  | { kind: "node"; node: string; device: string; name: string; tool: string; input: Record<string, Json>; what: string }
  /**
   * A mail (§16.2): as the owner, from their own mail (`via` is the
   * extension that sends it), or as Atlas, from Atlas's own address. The
   * owner can change who it's to, the subject and the words in the card.
   */
  | {
      kind: "email";
      name: string;
      as: "owner" | "atlas";
      via: string;
      from: string;
      to: string[];
      cc?: string[];
      subject: string;
      text: string;
      /** The service's thread, a Message-ID it answers and the ones before, to keep a reply in its conversation. */
      thread?: string;
      in_reply_to?: string;
      references?: string[];
      /** The person it's to, when it's one person Atlas knows. */
      person?: string;
    };

/** Sending a form can't be taken back (VISION §12.1 lists submit with the things that can't be undone). */
export const kindOf = (a: Action): ToolKind =>
  a.kind === "webhook" ||
  a.kind === "site" ||
  a.kind === "node" ||
  a.kind === "mcp_add" ||
  a.kind === "email" ||
  (a.kind === "vault" && !a.card) ||
  (a.kind === "mcp" && !a.destructive)
    ? "outside"
    : "irreversible";

/** What earned trust is counted by: each webhook on its own. Nothing that can't be undone is ever trusted. */
export const trustKey = (a: Action): string | null =>
  a.kind === "webhook"
    ? `webhook:${a.webhook}`
    : a.kind === "mcp"
      ? `mcp:${a.server}:${a.tool}`
      : a.kind === "node"
        ? // On a device, trust is earned for exactly this, not for every command the tool could run.
          `node:${a.node}:${a.tool}:${JSON.stringify(a.input)}`
        : a.kind === "email"
          ? // Mail is trusted by who it's to and whose name it's in: "mail to Doug as you".
            `email:${a.as}:${[...a.to, ...(a.cc ?? [])]
              .map((x) => x.toLowerCase())
              .sort()
              .join(",")}`
          : null;

export const needsHold = (actions: Action[]) => actions.some((a) => ASKS[kindOf(a)].hold);

/** How long an approval waits before it expires. */
export const EXPIRES_MS = 12 * 3600_000;

/** Approvals of one action as-is before Atlas offers to stop asking (§12.2). */
export const TRUST_AFTER = 5;

export interface Trust {
  name: string;
  /** Approvals in a row without changes. */
  as_is: number;
  /** Atlas has offered to stop asking; the offer waits in Inbox until answered. */
  offered: boolean;
  /** When the owner said Atlas could stop asking, or null. */
  trusted_at: number | null;
}

export const trustTable = (sql: Sql): Record<string, Trust> => getState<Record<string, Trust>>(sql, "trust") ?? {};

export function isTrusted(sql: Sql, a: Action): boolean {
  const key = trustKey(a);
  return key != null && ASKS[kindOf(a)].asks === "until_trusted" && trustTable(sql)[key]?.trusted_at != null;
}

export function setTrust(sql: Sql, key: string, trusted: boolean): Trust | null {
  const all = trustTable(sql);
  const t = all[key];
  if (!t) return null;
  all[key] = { ...t, offered: false, as_is: 0, trusted_at: trusted ? Date.now() : null };
  setState(sql, "trust", all);
  return all[key]!;
}

/** Counts an approval toward earned trust. Returns the keys Atlas should now offer to stop asking for. */
export function countApproval(sql: Sql, actions: Action[], asIs: boolean): string[] {
  const all = trustTable(sql);
  const offers: string[] = [];
  for (const a of actions) {
    const key = trustKey(a);
    if (!key || ASKS[kindOf(a)].asks !== "until_trusted") continue;
    const t = all[key] ?? { name: a.name, as_is: 0, offered: false, trusted_at: null };
    t.name = a.name;
    t.as_is = asIs ? t.as_is + 1 : 0;
    if (t.as_is >= TRUST_AFTER && !t.offered && t.trusted_at == null) {
      t.offered = true;
      offers.push(key);
    }
    all[key] = t;
  }
  setState(sql, "trust", all);
  return offers;
}

/** A decline starts the count again. */
export function countDecline(sql: Sql, actions: Action[]): void {
  const all = trustTable(sql);
  for (const a of actions) {
    const key = trustKey(a);
    if (key && all[key]) all[key] = { ...all[key]!, as_is: 0 };
  }
  setState(sql, "trust", all);
}

/** What an approval holds beyond its title. */
export interface ApprovalDetail {
  actions: Action[];
  [k: string]: Json | Action[];
}

export const actionsOf = (item: AgendaItem): Action[] => ((item.source.detail?.actions ?? []) as unknown as Action[]) ?? [];

/** The approval this run already opened, so a plan of several steps is one card. */
export function openApproval(sql: Sql, runId: string): AgendaItem | null {
  const r = sql
    .exec<{ id: string }>(
      `SELECT id FROM agenda WHERE kind = 'approval' AND state = 'scheduled' AND json_extract(source, '$.run_id') = ? LIMIT 1`,
      runId,
    )
    .toArray()[0];
  return r ? getItem(sql, r.id) : null;
}

export const titleOf = (actions: Action[]) =>
  actions
    .map((a) =>
      a.kind === "webhook"
        ? a.name
        : a.kind === "delete"
          ? `Delete ${a.name}`
          : a.kind === "vault"
            ? `Use ${a.name} on ${a.host}`
            : a.kind === "mcp_add"
              ? `Connect ${a.name}`
              : a.name,
    )
    .join(", then ");

/** Adds an action to this run's approval, making the approval if it's the first. */
export function requestApproval(
  sql: Sql,
  o: { run_id: string; log_id: string | null; action: Action; now?: number; read_web?: boolean },
): { item: AgendaItem; created: boolean } {
  const open = openApproval(sql, o.run_id);
  if (open) {
    const actions = [...actionsOf(open), o.action];
    const source = {
      ...open.source,
      detail: { ...(open.source.detail ?? {}), actions: actions as unknown as Json, ...(o.read_web ? { read_web: true } : {}) },
    };
    sql.exec(
      `UPDATE agenda SET title = ?, source = ?, updated_at = ? WHERE id = ?`,
      titleOf(actions),
      JSON.stringify(source),
      Date.now(),
      open.id,
    );
    return { item: getItem(sql, open.id)!, created: false };
  }
  const item = createItem(sql, {
    kind: "approval",
    title: titleOf([o.action]),
    due_at: (o.now ?? Date.now()) + EXPIRES_MS,
    source: {
      run_id: o.run_id,
      ...(o.log_id ? { log_id: o.log_id } : {}),
      via: "approval",
      detail: { actions: [o.action] as unknown as Json, ...(o.read_web ? { read_web: true } : {}) },
    },
  });
  return { item, created: true };
}

/** Approvals waiting on the owner, oldest first. */
export function waitingApprovals(sql: Sql): AgendaItem[] {
  return sql
    .exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'approval' AND state = 'scheduled' ORDER BY created_at`)
    .toArray()
    .map((r) => getItem(sql, r.id)!);
}
