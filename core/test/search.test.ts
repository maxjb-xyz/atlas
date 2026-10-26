// ⌘K over everything (M7 W20): what the owner's words find across what Atlas keeps.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { searchEverything } from "../src/search";
import { migrate } from "../src/store/db";
import { append } from "../src/store/log";
import { saveSkill } from "../src/skills";
import { env } from "./helpers";

describe("searching everything", () => {
  it("finds skills and moments in the conversation by every word, and nothing for words that don't all match", () =>
    runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName(`q-${crypto.randomUUID()}`)), (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      saveSkill(sql, {
        name: "launch-video-production",
        description: "Plan and produce a music-led launch video with staged approvals.",
        body: "1. Find the track, then cut to it.\n2. Ask before posting.",
        by: "atlas",
      });
      append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text: "Make a launch video for Atlas to post on X" } });
      append(sql, { actor: "atlas", kind: "message.out", surface: "app", body: { text: "On it. I'll find a track first." } });
      // A job's own thread isn't the conversation.
      append(sql, { actor: "owner", kind: "message.in", surface: "app", body: { text: "launch video, the faster cut", job: "ag_x" } });

      const hits = searchEverything(sql, "launch video", []);
      expect(hits.map((h) => [h.group, h.title])).toEqual([
        ["skills", "launch-video-production"],
        ["conversation", "Make a launch video for Atlas to post on X"],
      ]);
      expect(hits[1]).toMatchObject({ by: "owner", sub: "You" });
      expect(searchEverything(sql, "launch dentist", [])).toEqual([]);
      expect(searchEverything(sql, "   ", [])).toEqual([]);
    }));
});
