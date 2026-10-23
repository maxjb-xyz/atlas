// A face's settings (VISION §7.2), as the app sends them and Atlas keeps them.

import { z } from "zod";

export const SHARES = ["free_busy", "public", "status"] as const;
export const CANS = ["messages", "hold_time", "answer", "collect"] as const;
export const PULLS = ["urgent", "money", "cant_answer", "people"] as const;

export const FaceInput = z.object({
  id: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(60),
  intro: z.string().trim().max(400).default(""),
  /** "email" for Atlas's own address; a chat extension's id ("telegram"). */
  addresses: z.array(z.string().max(40)).max(10).default([]),
  audience: z.enum(["anyone", "known", "people"]).default("anyone"),
  /** Person records, when the audience is specific people. */
  people: z.array(z.string().max(64)).max(50).default([]),
  areas: z.array(z.string().max(64)).max(10).default([]),
  /** What it shares from each area, by area id. */
  shares: z.record(z.string().max(64), z.array(z.enum(SHARES))).default({}),
  can: z.array(z.enum(CANS)).default(["messages", "answer"]),
  pulls: z.array(z.enum(PULLS)).default(["urgent", "money", "cant_answer"]),
  /** Person records whose messages always pull the owner in. */
  pull_people: z.array(z.string().max(64)).max(50).default([]),
  speaks_as: z.enum(["atlas", "owner"]).default("atlas"),
  digest: z.enum(["daily", "off"]).default("daily"),
  on: z.boolean().default(true),
});
export type FaceInput = z.infer<typeof FaceInput>;
export type Face = FaceInput & { id: string; made_at: number; updated_at: number };
