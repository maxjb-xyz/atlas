// Members (VISION §7.1): people who share the owner's Atlas, each with an
// Atlas of their own. The owner invites one with a link and a role; they
// sign in with their own passkey and get their own agent (thread, records,
// voice settings), which nobody else can read, the owner included. What
// they share is an area (§6): its records live with the owner's agent, and
// both see and write them.

import type { Sql } from "./store/db";
import { append } from "./store/log";
import { getState, setState } from "./store/state";

export interface Member {
  id: string;
  name: string;
  /** An admin can invite and remove members; a member can't. */
  role: "admin" | "member";
  invited_at: number;
  joined_at: number | null;
  /** The invite link's token, hashed, until it's used or runs out. */
  invite_hash: string | null;
  invite_expires: number;
}

/** An invite link is good this long. */
export const INVITE_MS = 7 * 86_400_000;

/** The agent a person's socket goes to: the owner's, or a member's own. */
export const agentNameOf = (member?: string | null) => (member ? `member-${member}` : "owner");
export const memberOfAgent = (name: string) => (name.startsWith("member-") ? name.slice(7) : null);

export const members = (sql: Sql): Member[] => getState<Member[]>(sql, "members") ?? [];
export const getMember = (sql: Sql, id: string) => members(sql).find((m) => m.id === id) ?? null;

const hash = async (token: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`atlas-invite:${token}`)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** A new member and their invite link's token (shown once). An invite again for someone not joined makes a new token. */
export async function invite(sql: Sql, o: { name: string; role: Member["role"]; id?: string }): Promise<{ member: Member; token: string }> {
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const all = members(sql);
  const had = o.id ? all.find((m) => m.id === o.id && !m.joined_at) : undefined;
  const member: Member = {
    id: had?.id ?? `mb${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    name: o.name.trim().slice(0, 60),
    role: o.role,
    invited_at: Date.now(),
    joined_at: null,
    invite_hash: await hash(token),
    invite_expires: Date.now() + INVITE_MS,
  };
  setState(sql, "members", had ? all.map((m) => (m.id === had.id ? member : m)) : [...all, member]);
  append(sql, { actor: "owner", kind: "settings.change", body: { member: "invited", name: member.name, role: member.role } });
  return { member, token };
}

/** The member an invite link is for, while it's good. */
export async function byInvite(sql: Sql, token: string): Promise<Member | null> {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const h = await hash(token);
  return members(sql).find((m) => m.invite_hash === h && !m.joined_at && m.invite_expires > Date.now()) ?? null;
}

export function joined(sql: Sql, id: string): void {
  setState(
    sql,
    "members",
    members(sql).map((m) => (m.id === id ? { ...m, joined_at: Date.now(), invite_hash: null } : m)),
  );
  const m = getMember(sql, id);
  if (m) append(sql, { actor: "owner", kind: "settings.change", body: { member: "joined", name: m.name } });
}

export function setRole(sql: Sql, id: string, role: Member["role"]): void {
  setState(
    sql,
    "members",
    members(sql).map((m) => (m.id === id ? { ...m, role } : m)),
  );
}

export function removeMember(sql: Sql, id: string): Member | null {
  const m = getMember(sql, id);
  if (!m) return null;
  setState(
    sql,
    "members",
    members(sql).filter((x) => x.id !== id),
  );
  append(sql, { actor: "owner", kind: "settings.change", body: { member: "removed", name: m.name } });
  return m;
}
