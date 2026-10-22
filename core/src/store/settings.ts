// Settings exist for people (rule 5): each one is something the owner can
// see and change in the app. Secrets are kept apart and never sent to the
// app or the model; the app only learns whether each one is set.

import { z } from "zod";
import { parse, type Sql } from "./db";
import { getState } from "./state";

/** The ChatGPT model new chains start with, and the one picked after sign-in when the plan has it. */
export const DEFAULT_CHATGPT_MODEL = "gpt-5.6-terra";

export const BrainChoice = z.object({
  provider: z.enum(["chatgpt", "workers-ai"]),
  model: z.string().min(1).max(200),
});
export type BrainChoice = z.infer<typeof BrainChoice>;

export const Settings = z.object({
  /** What the assistant is called (§26 open question 3: "Atlas" by default). */
  assistant_name: z.string().min(1).max(40).default("Atlas"),
  owner_name: z.string().max(80).default(""),
  /** One resolved time zone (§23.6). Set from the first browser that connects, then by the owner. */
  timezone: z.string().max(64).default(""),
  /** Ordered chains: the first healthy brain answers; the rest are fallbacks (§18). */
  brains: z
    .object({
      main: z.array(BrainChoice).min(1).max(5),
      voice: z.array(BrainChoice).min(1).max(5),
    })
    .default({
      main: [
        { provider: "chatgpt", model: DEFAULT_CHATGPT_MODEL },
        { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      ],
      voice: [
        { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
        { provider: "chatgpt", model: DEFAULT_CHATGPT_MODEL },
      ],
    }),
  voice: z
    .object({
      speech_in: z.enum(["workers-ai-flux", "elevenlabs-scribe"]).default("workers-ai-flux"),
      speech_out: z.enum(["elevenlabs", "workers-ai-aura"]).default("elevenlabs"),
      elevenlabs_voice_id: z.string().max(64).default("JBFqnCBsd6RMkjVDRZzb"),
      elevenlabs_model: z.string().max(64).default("eleven_v4_turbo"),
    })
    .default({
      speech_in: "workers-ai-flux",
      speech_out: "elevenlabs",
      elevenlabs_voice_id: "JBFqnCBsd6RMkjVDRZzb",
      elevenlabs_model: "eleven_v4_turbo",
    }),
  /** The character (§23.1): a preset, four scales, and the owner's own words. */
  character: z
    .object({
      preset: z.enum(["atlas", "butler", "coach", "friend", "quiet"]).default("atlas"),
      warmth: z.number().int().min(1).max(5).default(4),
      humor: z.number().int().min(1).max(5).default(3),
      directness: z.number().int().min(1).max(5).default(4),
      initiative: z.number().int().min(1).max(5).default(3),
      /** Anything else, in the owner's words: "Call me Max. Swear if you like." */
      notes: z.string().max(2_000).default(""),
    })
    .default({ preset: "atlas", warmth: 4, humor: 3, directness: 4, initiative: 3, notes: "" }),
  /** What the owner keeps in the sidebar's Pinned list: area ids and record ids (§21.1). */
  pins: z.array(z.string().max(64)).max(20).default([]),
  calendar: z
    .object({
      /** Calendar names to leave out of what Atlas reads. Empty means read them all. */
      hidden: z.array(z.string().max(200)).max(50).default([]),
    })
    .default({ hidden: [] }),
});
export type Settings = z.infer<typeof Settings>;

/**
 * A partial update from the app. Nested objects are replaced whole. Built
 * from each field without its default: `Settings.partial()` would fill every
 * missing key with its default, so changing one setting would reset the rest.
 */
const f = Settings.shape;
export const SettingsPatch = z.object({
  assistant_name: f.assistant_name.unwrap().optional(),
  owner_name: f.owner_name.unwrap().optional(),
  timezone: f.timezone.unwrap().optional(),
  brains: f.brains.unwrap().optional(),
  voice: f.voice.unwrap().optional(),
  character: f.character.unwrap().optional(),
  pins: f.pins.unwrap().optional(),
  calendar: f.calendar.unwrap().optional(),
} satisfies { [K in keyof typeof f]: z.ZodType });
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export function readSettings(sql: Sql): Settings {
  const stored: Record<string, unknown> = {};
  for (const row of sql.exec<{ key: string; value: string }>(`SELECT key, value FROM settings`)) {
    stored[row.key] = parse(row.value, undefined);
  }
  const result = Settings.safeParse(stored);
  if (result.success) return result.data;
  // A bad stored value falls back to its default rather than breaking every run.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) {
    const field = Settings.shape[k as keyof typeof Settings.shape];
    if (field && field.safeParse(v).success) clean[k] = v;
  }
  return Settings.parse(clean);
}

export function writeSettings(sql: Sql, patch: SettingsPatch): string[] {
  const valid = SettingsPatch.parse(patch);
  const keys: string[] = [];
  for (const [k, v] of Object.entries(valid)) {
    if (v === undefined) continue;
    sql.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, k, JSON.stringify(v));
    keys.push(k);
  }
  return keys;
}

// --- secrets -------------------------------------------------------------
// M0 keeps a handful of keys in the agent's own storage (encrypted at rest by
// Cloudflare). The vault (§15) replaces this in M3.

export type SecretName = "elevenlabs_api_key" | "icloud" | "chatgpt_tokens" | "chatgpt_login";

export function getSecret<T = string>(sql: Sql, name: SecretName): T | null {
  const row = sql.exec<{ value: string }>(`SELECT value FROM secrets WHERE name = ?`, name).toArray()[0];
  return row ? parse<T | null>(row.value, null) : null;
}

export function setSecret(sql: Sql, name: SecretName, value: unknown): void {
  if (value === null || value === undefined) {
    sql.exec(`DELETE FROM secrets WHERE name = ?`, name);
    return;
  }
  sql.exec(`INSERT OR REPLACE INTO secrets (name, value, updated_at) VALUES (?, ?, ?)`, name, JSON.stringify(value), Date.now());
}

/** Every stored secret string, for the scrubber at the exits (§4.4). */
export function secretValues(sql: Sql): string[] {
  const pick = (v: unknown, path: string[]): unknown =>
    path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
  const wanted: Array<[SecretName, string[]]> = [
    ["elevenlabs_api_key", []],
    ["icloud", ["app_password"]],
    ["chatgpt_tokens", ["access_token"]],
    ["chatgpt_tokens", ["refresh_token"]],
    ["chatgpt_tokens", ["id_token"]],
  ];
  const out: string[] = [];
  for (const [name, path] of wanted) {
    const v = pick(getSecret<unknown>(sql, name), path);
    if (typeof v === "string" && v.length >= 8) out.push(v);
  }
  // The last ID token is kept as a sign-in hint, outside the secrets; it still never leaves.
  const hint = getState<{ id_token?: unknown }>(sql, "chatgpt_client")?.id_token;
  if (typeof hint === "string" && hint.length >= 8 && !out.includes(hint)) out.push(hint);
  return out;
}
