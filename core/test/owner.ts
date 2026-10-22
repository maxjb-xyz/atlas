// Talking to the owner's agent the way the app does: a socket, a scripted
// brain, and a turn that waits for the run to end. Shared by the tests that
// drive whole runs (the web, the browser, the vault).

import { runInDurableObject, SELF } from "cloudflare:test";
import { type PersonAgent, seams } from "../src/agent";
import type { ServerMessage } from "../src/protocol";
import { migrate, type Sql } from "../src/store/db";
import type { LogRow } from "../src/store/log";
import { env, scripted, SECRET, type Step } from "./helpers";

export interface Socket {
  send(msg: object): void;
  next<T extends ServerMessage["type"]>(
    type: T,
    where?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
}

export async function connect(): Promise<Socket> {
  const res = await SELF.fetch("http://atlas.test/agents/person-agent/owner", {
    headers: { Upgrade: "websocket", authorization: `Bearer ${SECRET}` },
  });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as { type?: string };
    if (m.type?.startsWith("atlas.")) inbox.push(m as ServerMessage);
  });
  const s: Socket = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    async next(type, where = () => true) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const i = inbox.findIndex((m) => m.type === type && where(m as never));
        if (i >= 0) return inbox.splice(i, 1)[0] as never;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${type} within 5 s; got ${inbox.map((m) => m.type).join(", ")}`);
    },
  };
  s.send({ type: "atlas.hello", tz: "America/New_York" });
  await s.next("atlas.snapshot");
  return s;
}

export const inOwner = <T>(fn: (agent: PersonAgent, sql: Sql) => Promise<T> | T) =>
  runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName("owner")), async (agent: PersonAgent, state) => {
    migrate(state.storage.sql);
    return fn(agent, state.storage.sql);
  });

export function brain(steps: Step[]) {
  const b = scripted(steps, "chatgpt", "gpt-5.6-terra");
  seams.makeBrain = () => b.brain;
  return b;
}

/** Says something and waits for the run to end; returns its tool results and deliveries, and the run's id. */
export async function turn(s: Socket, text: string): Promise<{ results: LogRow[]; deliveries: LogRow[]; run: string }> {
  s.send({ type: "atlas.say", text, client_id: text });
  const started = await s.next("atlas.run", (m) => m.client_id === text);
  await s.next("atlas.run", (m) => m.run_id === started.run_id && m.state !== "running");
  const rows = await inOwner((_a, sql) =>
    sql.exec<{ kind: string; body: string }>(`SELECT kind, body FROM log WHERE run_id = ? ORDER BY seq`, started.run_id).toArray(),
  );
  const parsed = rows.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> })) as unknown as LogRow[];
  return {
    results: parsed.filter((r) => r.kind === "tool.result"),
    deliveries: parsed.filter((r) => r.kind === "delivery"),
    run: started.run_id!,
  };
}

/** What a tool gave the model, as text. */
export const out = (r: LogRow) => (typeof r.body.output === "string" ? r.body.output : JSON.stringify(r.body.output));
