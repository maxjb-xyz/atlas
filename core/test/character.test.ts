import { describe, expect, it } from "vitest";
import { character, DEFAULT_PERSONA, manner, PRESETS } from "../src/character";
import { PROMPTS, parseVerdict, runCharacterCheck, structuralVerdict, summary } from "../src/character-check";
import type { BrainRequest } from "../src/brains/types";
import { scripted, say } from "./helpers";

describe("the character", () => {
  it("is built from the preset, the scales and the owner's words", () => {
    const text = character("Atlas", "Max", { preset: "butler", warmth: 1, humor: 5, directness: 5, initiative: 1, notes: "Call me Max." });
    expect(text).toContain(PRESETS.butler.manner);
    expect(text).toContain("You're cool and businesslike");
    expect(text).toContain("You're playful and quick");
    expect(text).toContain("You're blunt.");
    expect(text).toContain("You answer what was asked and stop.");
    expect(text).toContain("In Max's own words, about how you should be: Call me Max.");
    // The default reads the same as it always has, plus its manner.
    expect(character("Atlas", "Max")).toContain(manner(DEFAULT_PERSONA, "Max"));
  });

  it("has presets whose scales are in range", () => {
    for (const p of Object.values(PRESETS)) for (const v of Object.values(p.scales)) expect(v).toBeGreaterThanOrEqual(1);
  });
});

describe("the character eval", () => {
  it("passes every in-character reply on the pattern checks", () => {
    expect(PROMPTS.length).toBe(16);
    for (const p of PROMPTS) expect([p.id, structuralVerdict(p.owner, p.reply).failed]).toEqual([p.id, []]);
  });

  it("catches what breaks character", () => {
    const failed = (owner: string, reply: string) => structuralVerdict(owner, reply).failed;
    expect(failed("Which camera?", "Here are some options:\n- The G7\n- The X100")).toEqual(expect.arrayContaining(["one_recommendation"]));
    expect(failed("hi", "## Summary\nAll good.")).toContain("no_headers");
    expect(failed("hi", "Based on what I know about you, you like tea.")).toContain("no_recitation");
    expect(failed("hi", "Done!\n---\nIs there anything else I can help with?")).toEqual(
      expect.arrayContaining(["no_dividers", "not_servile"]),
    );
    expect(failed("hi", "**Status:** fine")).toContain("no_label_dump");
    expect(failed("hi", "I can't, with the tools available.")).toContain("no_model_speak");
    expect(failed("Who am I?", "Who you are\nYou're Max.")).toContain("no_title_echo");
  });

  it("reads the judge's verdict, and calls an unreadable one a failure", () => {
    expect(parseVerdict('Sure: {"passed": true, "failed_checks": [], "notes": ""}')).toEqual({ passed: true, failed: [], notes: "" });
    expect(parseVerdict('{"passed": true, "failed_checks": ["no_moralizing"]}').passed).toBe(false);
    expect(parseVerdict("looks fine to me")).toMatchObject({ passed: false, failed: ["judge_unreadable"] });
  });

  it("has a different brain judge each one, and never judges a brain by itself", async () => {
    const two = PROMPTS.slice(0, 2);
    const a = scripted(
      [
        say("The X100."),
        say("The Thai place."),
        say('{"passed": true, "failed_checks": []}'),
        say('{"passed": false, "failed_checks": ["one_recommendation"], "notes": "a menu"}'),
      ],
      "chatgpt",
      "a",
    );
    const b = scripted(
      [say('{"passed": true, "failed_checks": []}'), say('{"passed": true, "failed_checks": []}'), say("- one\n- two"), say("Thai.")],
      "workers-ai",
      "b",
    );
    const checks = await runCharacterCheck([a.brain, b.brain], "SYSTEM", { prompts: two });
    expect(checks.map((c) => [c.brain, c.judge])).toEqual([
      ["chatgpt:a", "workers-ai:b"],
      ["workers-ai:b", "chatgpt:a"],
    ]);
    expect(checks[0]!.results.map((r) => r.verdict.passed)).toEqual([true, true]);
    expect(checks[1]!.results[0]!.verdict.failed).toEqual(expect.arrayContaining(["one_recommendation"]));
    expect((a.requests[0] as BrainRequest).system).toBe("SYSTEM");
    expect(summary(checks)).toContain("chatgpt:a 2 of 2 in character (judged by workers-ai:b)");

    const alone = await runCharacterCheck([scripted([], "chatgpt", "solo").brain], "SYSTEM", { prompts: two });
    expect(alone[0]!.note).toContain("no other brain to judge it");
  });
});
