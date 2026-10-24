// Nodes (VISION §16.3): devices that dial out to Atlas and offer local
// senses and hands. A node pairs once: it asks the Worker for a pairing code,
// shows it as a QR code and text, and the owner opens it signed in and says
// yes, which gives the node its own token. The node then holds one outgoing
// WebSocket to the person agent, says hello with its capabilities (tools
// with a JSON schema, which are sensitive, which act) and the events it
// sends, sends events, and answers calls. Atlas offers a node's tools only
// while it's online and allowed; sensitive ones start off. A call to a node
// that's offline waits on the clock and runs when it's back.
//
// The protocol is public (§16.3): the messages below are all of it. Every
// type starts with "node.": the socket also carries the Agents SDK's own
// messages (identity, status), which a device ignores.

import { z } from "zod";
import type { Json, Sql } from "./store/db";
import { append, type LogRow, type SenseItem } from "./store/log";
import { getState, setState } from "./store/state";

export const NODE_KINDS = ["desktop", "phone", "home", "browser", "other"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** A tool a node offers. */
export const Capability = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: z.string().min(1).max(600),
  /** JSON Schema for its input. */
  input: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  /** Starts off until the owner turns it on: screen, files, camera, running commands (§16.3). */
  sensitive: z.boolean().default(false),
  /** Does something beyond showing the owner a notification, so it asks first, like any outside action (§12.1). */
  acts: z.boolean().default(false),
});
export type Capability = z.infer<typeof Capability>;

/** What a node says on its socket. */
export const NodeMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("node.hello"),
    node: z.object({
      name: z.string().min(1).max(80),
      kind: z.enum(NODE_KINDS),
      platform: z.string().max(80).optional(),
      version: z.string().max(40).optional(),
    }),
    capabilities: z.array(Capability).max(40),
    events: z
      .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), description: z.string().max(300) }))
      .max(40)
      .default([]),
  }),
  z.object({
    type: z.literal("node.event"),
    event: z.string().max(40),
    body: z.record(z.string(), z.unknown()).default({}),
    at: z.number().optional(),
  }),
  z.object({
    type: z.literal("node.result"),
    id: z.string().max(64),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().max(4_000).optional(),
  }),
  z.object({ type: z.literal("node.ping") }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

/** What Atlas says to a node. */
export type AtlasToNode =
  | { type: "node.welcome"; node_id: string; allowed: Record<string, boolean> }
  | { type: "node.allowed"; allowed: Record<string, boolean> }
  | { type: "node.call"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "node.pong" }
  | { type: "node.unpaired" };

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  platform?: string;
  version?: string;
  /** SHA-256 of its token, so a stolen copy of the state can't connect. */
  token_hash: string;
  paired_at: number;
  last_seen: number;
  online: boolean;
  capabilities: Capability[];
  events: Array<{ name: string; description: string }>;
  /** Capabilities the owner turned on or off; one not listed follows its default (sensitive off, the rest on). */
  allowed: Record<string, boolean>;
  /** The node's last report of each event, for the situation (idle, battery). */
  state: Record<string, Json>;
}

/** A pairing waiting for the owner's yes. */
interface Pairing {
  code: string;
  poll_hash: string;
  name: string;
  kind: NodeKind;
  platform?: string;
  expires: number;
  /** Once the owner said yes: the node's id and its token, handed over once on the next poll. */
  paired?: { id: string; token: string };
}

/** How long a pairing code works. */
export const PAIR_MS = 10 * 60_000;
/** How many pairings may wait at once, so nobody can fill the list. */
const MAX_PAIRINGS = 5;

export const nodes = (sql: Sql): Node[] => getState<Node[]>(sql, "nodes") ?? [];
const saveNodes = (sql: Sql, all: Node[]) => setState(sql, "nodes", all);
const pairings = (sql: Sql): Pairing[] => (getState<Pairing[]>(sql, "node_pairings") ?? []).filter((p) => p.expires > Date.now());
const savePairings = (sql: Sql, all: Pairing[]) => setState(sql, "node_pairings", all);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function sha256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** A short code a person can read and type: eight letters and digits without look-alikes, as XXXX-XXXX. */
function pairCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const normCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(.{4})(.{4})$/, "$1-$2");

/** A device asks to pair: it gets a code to show and a secret to poll with. */
export async function startPairing(
  sql: Sql,
  o: { name: string; kind: NodeKind; platform?: string },
): Promise<{ code: string; poll: string; expires: number }> {
  const waiting = pairings(sql);
  if (waiting.length >= MAX_PAIRINGS) throw new Error("Too many devices are waiting to pair. Try again in ten minutes.");
  const code = pairCode();
  const poll = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const expires = Date.now() + PAIR_MS;
  savePairings(sql, [
    ...waiting,
    {
      code,
      poll_hash: await sha256(poll),
      name: o.name.slice(0, 80),
      kind: o.kind,
      ...(o.platform ? { platform: o.platform.slice(0, 80) } : {}),
      expires,
    },
  ]);
  return { code, poll, expires };
}

/** What the owner sees before saying yes. */
export function pairingFor(
  sql: Sql,
  code: string,
): { code: string; name: string; kind: NodeKind; platform?: string; expires: number } | null {
  const p = pairings(sql).find((x) => x.code === normCode(code) && !x.paired);
  return p ? { code: p.code, name: p.name, kind: p.kind, ...(p.platform ? { platform: p.platform } : {}), expires: p.expires } : null;
}

/** The owner's yes or no. A yes makes the node, with its token waiting for the device's next poll. */
export async function decidePairing(sql: Sql, code: string, yes: boolean): Promise<Node | null> {
  const all = pairings(sql);
  const p = all.find((x) => x.code === normCode(code) && !x.paired);
  if (!p) return null;
  if (!yes) {
    savePairings(
      sql,
      all.filter((x) => x !== p),
    );
    return null;
  }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const node: Node = {
    id: `node_${b64url(crypto.getRandomValues(new Uint8Array(9)))}`,
    name: uniqueName(sql, p.name),
    kind: p.kind,
    ...(p.platform ? { platform: p.platform } : {}),
    token_hash: await sha256(token),
    paired_at: Date.now(),
    last_seen: 0,
    online: false,
    capabilities: [],
    events: [],
    allowed: {},
    state: {},
  };
  saveNodes(sql, [...nodes(sql), node]);
  savePairings(
    sql,
    all.map((x) => (x === p ? { ...x, paired: { id: node.id, token }, expires: Date.now() + 2 * 60_000 } : x)),
  );
  append(sql, { actor: "owner", kind: "settings.change", body: { node: "paired", name: node.name } });
  return node;
}

function uniqueName(sql: Sql, name: string): string {
  const taken = new Set(nodes(sql).map((n) => n.name.toLowerCase()));
  let out = name.trim() || "Device";
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} ${i}`;
  return out;
}

/** The device polls: waiting, or its token (handed over once), or gone. */
export async function pollPairing(
  sql: Sql,
  poll: string,
): Promise<{ state: "waiting" | "expired" } | { state: "paired"; node_id: string; token: string; name: string }> {
  const h = await sha256(poll);
  const all = getState<Pairing[]>(sql, "node_pairings") ?? [];
  const p = all.find((x) => x.poll_hash === h);
  if (!p || p.expires < Date.now()) return { state: "expired" };
  if (!p.paired) return { state: "waiting" };
  savePairings(
    sql,
    all.filter((x) => x !== p),
  );
  return {
    state: "paired",
    node_id: p.paired.id,
    token: p.paired.token,
    name: nodes(sql).find((n) => n.id === p.paired!.id)?.name ?? p.name,
  };
}

/** The node a token belongs to. */
export async function nodeByToken(sql: Sql, token: string): Promise<Node | null> {
  if (!token || token.length > 200) return null;
  const h = await sha256(token);
  return nodes(sql).find((n) => n.token_hash === h) ?? null;
}

export function updateNode(sql: Sql, id: string, fn: (n: Node) => Node): Node | null {
  let out: Node | null = null;
  saveNodes(
    sql,
    nodes(sql).map((n) => (n.id === id ? (out = fn(n)) : n)),
  );
  return out;
}

export function removeNode(sql: Sql, id: string): Node | null {
  const gone = nodes(sql).find((n) => n.id === id) ?? null;
  if (!gone) return null;
  saveNodes(
    sql,
    nodes(sql).filter((n) => n.id !== id),
  );
  append(sql, { actor: "owner", kind: "settings.change", body: { node: "removed", name: gone.name } });
  return gone;
}

/** Whether a capability is on: the owner's switch, else sensitive ones off and the rest on. */
export const allowed = (n: Node, c: Capability) => n.allowed[c.name] ?? !c.sensitive;
export const allowedMap = (n: Node) => Object.fromEntries(n.capabilities.map((c) => [c.name, allowed(n, c)]));

/** A node by name (any case) or id. */
export function findNode(sql: Sql, ref: string): Node | null {
  const r = ref.trim().toLowerCase();
  const all = nodes(sql);
  return (
    all.find((n) => n.id === ref) ??
    all.find((n) => n.name.toLowerCase() === r) ??
    (all.length === 1 && /^(my )?(mac|computer|laptop|desktop|device)$/.test(r) ? all[0]! : null)
  );
}

/** A node coming or going, as a `sense` row. Its events go through the intake instead (`nodeItem`). */
export function logNode(sql: Sql, n: Node, event: "online" | "offline"): LogRow {
  return append(sql, {
    actor: "system",
    kind: "sense",
    body: { source: "device", node: { id: n.id, name: n.name }, event } as never,
  });
}

/** One of a node's events, as an item for the intake (§10.4). */
export function nodeItem(n: Node, event: string, body: unknown): SenseItem {
  return {
    source: "device",
    event,
    what: `${n.name} says ${event.replace(/_/g, " ")}: ${JSON.stringify(body ?? {}).slice(0, 300)}`,
    node: { id: n.id, name: n.name },
    body,
    thread: n.id,
  };
}

/** A capability's input fields, as "(text, title?)": optional ones marked, so device_call gets them right. */
function fields(c: Capability): string {
  const props = c.input.properties && typeof c.input.properties === "object" ? Object.keys(c.input.properties) : [];
  const required = Array.isArray(c.input.required) ? (c.input.required as string[]) : [];
  return props.length ? `(${props.map((p) => (required.includes(p) ? p : `${p}?`)).join(", ")})` : "";
}

/** The devices line for every prompt: each node, online or not, and what it offers. */
export function nodesLine(sql: Sql): string {
  const all = nodes(sql);
  if (!all.length) return "";
  return `Paired devices (use their tools with device_call; one that's offline runs the call when it's back):\n${all
    .map((n) => {
      const tools = n.capabilities.map(
        (c) =>
          `${c.name}${fields(c)}${allowed(n, c) ? (c.acts ? " (asks first)" : "") : " (off; the owner turns it on in Abilities → Devices)"}`,
      );
      const st = Object.entries(n.state)
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return `- ${n.name} (${n.kind}${n.platform ? `, ${n.platform}` : ""}): ${n.online ? "online" : `offline, last seen ${n.last_seen ? new Date(n.last_seen).toISOString() : "never"}`}${st ? `; ${st}` : ""}. Tools: ${tools.join(", ") || "none yet"}.`;
    })
    .join("\n")}`;
}

/** What Abilities → Devices shows of each node. */
export interface NodeView {
  id: string;
  name: string;
  kind: NodeKind;
  platform: string | null;
  online: boolean;
  last_seen: number;
  paired_at: number;
  capabilities: Array<{ name: string; description: string; sensitive: boolean; acts: boolean; on: boolean }>;
}

export const nodeView = (n: Node): NodeView => ({
  id: n.id,
  name: n.name,
  kind: n.kind,
  platform: n.platform ?? null,
  online: n.online,
  last_seen: n.last_seen,
  paired_at: n.paired_at,
  capabilities: n.capabilities.map((c) => ({
    name: c.name,
    description: c.description,
    sensitive: c.sensitive,
    acts: c.acts,
    on: allowed(n, c),
  })),
});
