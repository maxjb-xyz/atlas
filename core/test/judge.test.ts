// The Jarvis bar's judge (VISION §23.7): `POST /api/judge` hands a
// conversation and its yardstick to the character check's judges, with a
// fake brain here, and says what the judge found.

import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { judgeTranscript } from "../src/character-check";
import { BrainError } from "../src/brains/types";
import { say, scripted, SECRET } from "./helpers";
import { inOwner } from "./owner";

afterEach(() => {
  seams.makeBrain = null;
});

const judge = (body: unknown) =>
  SELF.fetch("http://atlas.test/api/judge", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const YARDSTICK = "Atlas remembers the owner picked Lisbon and plans the day there, without asking which city again.";
const TRANSCRIPT = [
  { who: "owner" as const, text: "Lisbon over Porto, I want the water." },
  { who: "atlas" as const, text: "Lisbon it is." },
  { who: "owner" as const, text: "Plan day one." },
  { who: "atlas" as const, text: "Lisbon or Porto?", tools: ["recall"] },
];

describe("the Jarvis bar's judge", () => {
  it("asks a judge brain with the yardstick and the whole conversation, and returns its verdict", async () => {
    const fake = scripted([say('{"passed": false, "failed_checks": ["asked_again"], "notes": "It asked which city twice."}')]);
    seams.makeBrain = () => fake.brain;
    const res = await judge({ yardstick: YARDSTICK, transcript: TRANSCRIPT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passed: false, failed: ["asked_again"], notes: "It asked which city twice." });
    const prompt = String(fake.requests[0]!.messages[0]!.content);
    expect(prompt).toContain(YARDSTICK);
    expect(prompt).toContain("Owner: Plan day one.");
    expect(prompt).toContain("Atlas (used recall): Lisbon or Porto?");
    expect(fake.requests[0]!.tools).toEqual([]);
  });

  it("passes what the judge passes, through the agent", async () => {
    seams.makeBrain = () => scripted([say('{"passed": true, "failed_checks": [], "notes": "Kept the pick."}')]).brain;
    const v = await inOwner((agent) => agent.apiJudge({ yardstick: YARDSTICK, transcript: TRANSCRIPT.slice(0, 2) }));
    expect(v).toMatchObject({ passed: true, failed: [], notes: "Kept the pick." });
    expect(v.judge).toBeTruthy();
  });

  it("moves to the next judge when one fails, and says why when none answers", async () => {
    const down = scripted([new BrainError("HTTP 503 from gateway.ai.cloudflare.com: overloaded")], "workers-ai", "down");
    const up = scripted([say('{"passed": true, "failed_checks": []}')], "chatgpt", "up");
    expect(await judgeTranscript([down.brain, up.brain], YARDSTICK, TRANSCRIPT)).toMatchObject({ passed: true, judge: "chatgpt:up" });
    const none = await judgeTranscript(
      [scripted([new BrainError("HTTP 401 from api.anthropic.com: invalid x-api-key")]).brain],
      YARDSTICK,
      TRANSCRIPT,
    );
    expect(none).toMatchObject({ passed: false, failed: ["judge_unreachable"], judge: null });
    expect(none.notes).toContain("HTTP 401 from api.anthropic.com: invalid x-api-key");
    expect((await judgeTranscript([], YARDSTICK, TRANSCRIPT)).failed).toEqual(["no_judge"]);
  });

  it("says what to send when the body is wrong", async () => {
    const res = await judge({ yardstick: "", transcript: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"yardstick"');
    expect((await judge({ yardstick: "y", transcript: [{ who: "someone", text: "hi" }] })).status).toBe(400);
  });
});
