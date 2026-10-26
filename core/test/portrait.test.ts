// The portrait (§5.1): rewritten each night from what was said, in the cached part of every turn, and the owner's
// own words kept as true.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams } from "../src/agent";
import { ensurePortrait, getPortrait, readPortrait, savePortrait } from "../src/portrait";
import { getItem, rearm } from "../src/store/agenda";
import { migrate } from "../src/store/db";
import { append } from "../src/store/log";
import { env, say, scripted } from "./helpers";

/** The night's rewrite, made due now. */
function due(sql: import("../src/store/db").Sql): string {
  const id =
    ensurePortrait(sql, "UTC")?.id ??
    sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'portrait' AND state = 'scheduled'`).one().id;
  rearm(sql, id, Date.now() - 1);
  return id;
}

afterEach(() => {
  seams.makeBrain = null;
});

describe("the portrait", () => {
  it("reads the night's answer in its shape, and nothing when it isn't", () => {
    expect(readPortrait("PORTRAIT:\nMax studies political science at UCF.\nLEARNED:\n- You're taking French.\n- none")).toEqual({
      text: "Max studies political science at UCF.",
      learned: ["You're taking French."],
    });
    expect(readPortrait("Here's what I think.")).toBeNull();
    expect(readPortrait("PORTRAIT:\nA.\nLEARNED:\nnone")).toEqual({ text: "A.", learned: [] });
  });

  it("is rewritten at night from what was said, sits in every turn's prompt, and skips a night with nothing new", async () => {
    const b = scripted([
      say("PORTRAIT:\nMax is a student at UCF who likes short answers.\nLEARNED:\n- You have French homework due on Wednesdays."),
      say("Noted."),
    ]);
    seams.makeBrain = () => b.brain;
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`pt-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      append(sql, { actor: "owner", kind: "message.in", body: { text: "My French homework is due every Wednesday." } });
      const item = due(sql);
      await agent.onAgendaDue({ id: item });
      expect(getPortrait(sql)).toMatchObject({
        text: "Max is a student at UCF who likes short answers.",
        learned: ["You have French homework due on Wednesdays."],
        by: "atlas",
      });
      expect(String(b.requests[0]!.messages.at(-1)!.content)).toContain("Owner: My French homework is due every Wednesday.");
      // The next night is on the clock, and with nothing new it runs no turn.
      const next = due(sql);
      await agent.onAgendaDue({ id: next });
      expect(b.requests).toHaveLength(1);
      expect(getItem(sql, next)!.state).toBe("done");
      // Every turn carries it.
      await agent.apiTurn("hi");
      expect(b.requests[1]!.system).toContain("Max is a student at UCF who likes short answers.");
    });
  });

  it("keeps the owner's own words as true when it rewrites", async () => {
    const b = scripted([say("PORTRAIT:\nMax, who goes by Maximus.\nLEARNED:\nnone")]);
    seams.makeBrain = () => b.brain;
    const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`pt-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      savePortrait(sql, { text: "Goes by Maximus.", learned: [], by: "owner", through_seq: 0 });
      append(sql, { actor: "owner", kind: "message.in", body: { text: "hello" } });
      const item = due(sql);
      await agent.onAgendaDue({ id: item });
      expect(String(b.requests[0]!.messages.at(-1)!.content)).toContain("their words are true, so keep them");
    });
  });
});
