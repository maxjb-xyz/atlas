import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import type { Brain } from "../src/brains/types";
import { fakeCalendar, fakeEmbedder } from "./helpers";
import { connect, inOwner } from "./owner";

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  // A brain that takes forever, until it's stopped.
  seams.makeBrain = () =>
    ({
      provider: "workers-ai",
      model: "slow",
      async *stream(req) {
        yield { type: "text", text: "" };
        await new Promise((resolve) => req.signal?.addEventListener("abort", resolve));
        throw new Error("aborted");
      },
    }) as Brain;
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("stopping a turn", () => {
  it("ends the owner's run at once, says it was stopped, and keeps it out of Inbox", async () => {
    const s = await connect();
    s.send({ type: "atlas.say", text: "think about this for a very long time", client_id: "slow-1" });
    const started = await s.next("atlas.run", (m) => m.client_id === "slow-1");
    s.send({ type: "atlas.run.stop", run_id: started.run_id });
    const ended = await s.next("atlas.run", (m) => m.run_id === started.run_id && m.state !== "running");
    expect(ended.state).toBe("failed");
    const end = await inOwner((_a, sql) =>
      JSON.parse(sql.exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'run.end' AND run_id = ?`, started.run_id).one().body),
    );
    expect(end).toMatchObject({ state: "failed", interrupted: true, error: "You stopped it." });
    s.send({ type: "atlas.inbox" });
    const items = (await s.next("atlas.inbox.items")).items;
    expect(items.some((i) => i.run_id === started.run_id)).toBe(false);

    // Stopping what isn't running says so.
    s.send({ type: "atlas.run.stop", run_id: started.run_id! });
    expect((await s.next("atlas.error")).message).toBe("That isn't running any more.");
  });
});
