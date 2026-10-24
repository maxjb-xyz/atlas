// Settings exist for people (rule 5): each one is something the owner can
// see and change in the app. Secrets are kept apart and never sent to the
// app or the model; the app only learns whether each one is set.

import { dataKeyView, isSealed, open, seal } from "./sealed";
import { z } from "zod";
import { parse, type Sql } from "./db";
import { getState } from "./state";

/** The ChatGPT model new chains start with, and the one picked after sign-in when the plan has it. */
export const DEFAULT_CHATGPT_MODEL = "gpt-5.6-terra";

export const BrainChoice = z.object({
  provider: z.enum(["chatgpt", "workers-ai", "anthropic"]),
  model: z.string().min(1).max(200),
});
export type BrainChoice = z.infer<typeof BrainChoice>;

/** A named brain for a kind of work (§18): "Quick", "Deep", with a line on what it's good for. */
export const NamedBrain = z.object({
  name: z.string().trim().min(1).max(24),
  line: z.string().trim().max(120).default(""),
  chain: z.array(BrainChoice).min(1).max(5),
});
export type NamedBrain = z.infer<typeof NamedBrain>;

/** The kinds of work that each use a named brain when the owner picks one, and the main chain otherwise. */
export const WORK_KINDS = ["helpers", "research", "job_work", "job_looks", "skill_review"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

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
  /**
   * Named brains for kinds of work (§18), and which one each kind uses (none means the main chain). Kept apart
   * from `brains`, which the role chains replace whole when they're saved.
   */
  named_brains: z
    .object({
      brains: z.array(NamedBrain).max(8).default([]),
      uses: z.object(Object.fromEntries(WORK_KINDS.map((k) => [k, z.string().max(24).nullable().default(null)]))).prefault({}),
    })
    .prefault({}),
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
  /** The web (§9.1): which search Atlas uses: Cloudflare's, built in, or a search extension's id (§17). */
  web: z.object({ search: z.string().min(1).max(40).default("cloudflare") }).default({ search: "cloudflare" }),
  /** How messages reach the owner when the app isn't in view (§14). */
  notifications: z
    .object({
      /** Push notifications to the device used last, when no app is in view. */
      push: z.boolean().default(true),
      /** Non-urgent pushes wait until these hours end. Local times, HH:mm. */
      quiet: z
        .object({
          on: z.boolean().default(false),
          from: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .default("22:00"),
          to: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .default("07:00"),
        })
        .default({ on: false, from: "22:00", to: "07:00" }),
      /** The daily interruption budget (§14): pushes a day for things that can wait. 0 means no limit. */
      budget: z.number().int().min(0).max(100).default(10),
      /** Where Atlas reaches the owner when the app isn't in view: a push, or a chat channel they've linked (§16.1). */
      reach: z.string().min(1).max(40).default("push"),
    })
    .default({ push: true, quiet: { on: false, from: "22:00", to: "07:00" }, budget: 10, reach: "push" }),
  /** Location (§10.1): whether Atlas takes in what the phone sends. Off drops it, and Atlas says it doesn't know where you are. */
  location: z.object({ on: z.boolean().default(true) }).default({ on: true }),
  /** Maps (§19.1): which maps extension answers (§17): OpenStreetMap's by default, Mapbox's by key, or another. */
  maps: z.object({ provider: z.string().min(1).max(40).default("osm") }).default({ provider: "osm" }),
  /**
   * Speaking up (§10.3): whether Atlas may tell the owner things on its own.
   * `noticing` covers whatever its senses notice (a move, a change on the
   * calendar, the weather, traffic, a device, a webhook); `leave` the look
   * before an event with a place. `quiet_about` is what the owner doesn't
   * want to hear about and `tell_about` what they always do, in their
   * words: Atlas and `decide` both see them, and the owner edits them in
   * the app. The daily looks are automations (§13.4), with their own times.
   */
  speaking: z
    .object({
      noticing: z.boolean().default(true),
      leave: z.boolean().default(true),
      quiet_about: z.array(z.string().min(1).max(120)).max(30).default([]),
      /** What the owner always wants to hear about, in their words (from "why didn't you tell me?"). */
      tell_about: z.array(z.string().min(1).max(120)).max(30).default([]),
    })
    .default({ noticing: true, leave: true, quiet_about: [], tell_about: [] }),
  /** How Atlas says temperatures, speeds and distances. "auto" follows the time zone: US zones get °F and miles. */
  units: z.enum(["auto", "us", "metric"]).default("auto"),
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
  named_brains: f.named_brains.unwrap().optional(),
  voice: f.voice.unwrap().optional(),
  character: f.character.unwrap().optional(),
  pins: f.pins.unwrap().optional(),
  calendar: f.calendar.unwrap().optional(),
  notifications: f.notifications.unwrap().optional(),
  web: f.web.unwrap().optional(),
  location: f.location.unwrap().optional(),
  maps: f.maps.unwrap().optional(),
  units: f.units.unwrap().optional(),
  speaking: f.speaking.unwrap().optional(),
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
// Keys, tokens and the vault (§15), in the agent's own storage: encrypted at
// rest by Cloudflare, and sealed by Atlas with this deployment's own key
// (store/sealed.ts, §20), so a copy of storage doesn't carry them.

export type SecretName =
  | "elevenlabs_api_key"
  /** An Anthropic API key, for Claude as a brain (§18). */
  | "anthropic_api_key"
  /** Keys for the web searches that need one (§9.1). */
  | "tavily_api_key"
  | "brave_api_key"
  | "exa_api_key"
  | "icloud"
  | "chatgpt_tokens"
  | "chatgpt_login"
  /** This deployment's VAPID key pair, which signs its push notifications. */
  | "push_vapid"
  /** The owner's webhooks: their addresses are credentials. */
  | "webhooks"
  /** The vault (§15): logins, cards and keys, by name, tied to sites. */
  | "vault"
  /** OwnTracks' own user and password (§10.1), for its posts to the Worker and nothing else. */
  | "owntracks"
  /** A Mapbox token, when the owner picks Mapbox for maps (§19.1). */
  | "mapbox_token"
  /** A Cloudflare API token for the account Atlas's own address is in (§16.2). */
  | "cf_mail_token"
  /** The key Atlas's mail relay signs each mail with. */
  | "mail_relay"
  /** Each webhook source's key (§10.4), by its id. */
  | "sense_hooks"
  /** An extension's secrets (§17), by name: what the owner pasted, and the tokens of a sign-in the core ran for it. */
  | `ext:${string}`;

export function getSecret<T = string>(sql: Sql, name: SecretName): T | null {
  const row = sql.exec<{ value: string }>(`SELECT value FROM secrets WHERE name = ?`, name).toArray()[0];
  const value = row ? open(name, row.value) : null;
  return value === null ? null : parse<T | null>(value, null);
}

export function setSecret(sql: Sql, name: SecretName, value: unknown): void {
  if (value === null || value === undefined) {
    sql.exec(`DELETE FROM secrets WHERE name = ?`, name);
    return;
  }
  // A value that can't be opened (the key was changed) is never written over: reading it gave null, so a write
  // would replace what's there (a whole vault) with a fresh value. Putting the old key back brings it all back.
  const was = sql.exec<{ value: string }>(`SELECT value FROM secrets WHERE name = ?`, name).toArray()[0]?.value;
  if (was !== undefined && isSealed(was) && open(name, was) === null)
    throw new Error(`Not saved, so nothing is lost: ${dataKeyView().unreadable ?? `${name} can't be opened with this deployment's key.`}`);
  sql.exec(
    `INSERT OR REPLACE INTO secrets (name, value, updated_at) VALUES (?, ?, ?)`,
    name,
    seal(name, JSON.stringify(value)),
    Date.now(),
  );
}

/**
 * Seals every secret still kept as it was before sealing (§20), once this
 * deployment has its key: on the first start after the update that added
 * sealing, and after the owner sets ATLAS_DATA_KEY. Returns how many it sealed.
 */
export function sealSecrets(sql: Sql): number {
  if (dataKeyView().state !== "on") return 0;
  let n = 0;
  for (const r of sql.exec<{ name: string; value: string }>(`SELECT name, value FROM secrets`).toArray()) {
    if (isSealed(r.value)) continue;
    sql.exec(`UPDATE secrets SET value = ? WHERE name = ?`, seal(r.name, r.value), r.name);
    n++;
  }
  return n;
}

/** Every stored secret string, for the scrubber at the exits (§4.4). */
export function secretValues(sql: Sql): string[] {
  const pick = (v: unknown, path: string[]): unknown =>
    path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
  const wanted: Array<[SecretName, string[]]> = [
    ["elevenlabs_api_key", []],
    ["anthropic_api_key", []],
    ["tavily_api_key", []],
    ["brave_api_key", []],
    ["exa_api_key", []],
    ["icloud", ["app_password"]],
    ["chatgpt_tokens", ["access_token"]],
    ["chatgpt_tokens", ["refresh_token"]],
    ["chatgpt_tokens", ["id_token"]],
    ["push_vapid", ["private_jwk", "d"]],
    ["owntracks", ["password"]],
    ["mapbox_token", []],
    ["cf_mail_token", []],
    ["mail_relay", []],
  ];
  const hooks = getSecret<Array<{ url?: unknown }>>(sql, "webhooks") ?? [];
  const out: string[] = [];
  for (const [name, path] of wanted) {
    const v = pick(getSecret<unknown>(sql, name), path);
    if (typeof v === "string" && v.length >= 8) out.push(v);
  }
  for (const h of hooks) if (typeof h.url === "string" && h.url.length >= 8) out.push(h.url);
  // Extensions' secrets (§17): keys, passwords and sign-in tokens never leave either.
  for (const r of sql.exec<{ name: string; value: string }>(`SELECT name, value FROM secrets WHERE name LIKE 'ext:%'`).toArray()) {
    const value = open(r.name, r.value);
    for (const v of Object.values(parse<Record<string, unknown>>(value ?? "{}", {})))
      if (typeof v === "string" && v.length >= 8) out.push(v);
  }
  // The vault's secret values (§15): passwords, card numbers and codes, keys and seeds never leave.
  for (const e of getSecret<Array<{ values?: Record<string, unknown>; totp?: unknown }>>(sql, "vault") ?? []) {
    for (const k of ["password", "number", "cvc", "key"]) {
      const v = e.values?.[k];
      if (typeof v === "string" && v.length >= 3) out.push(v);
    }
    if (typeof e.totp === "string" && e.totp.length >= 8) out.push(e.totp);
  }
  // The last ID token is kept as a sign-in hint, outside the secrets; it still never leaves.
  const hint = getState<{ id_token?: unknown }>(sql, "chatgpt_client")?.id_token;
  if (typeof hint === "string" && hint.length >= 8 && !out.includes(hint)) out.push(hint);
  return out;
}

/**
 * The chain for a kind of work (§18): the named brain asked for when it
 * exists, else the one the owner set for this kind, else the main chain.
 * An unknown name is refused with the names there are, so a model can't
 * pick a brain that doesn't exist.
 */
export function chainFor(settings: Settings, kind: WorkKind, asked?: string | null): { name: string; chain: BrainChoice[] } {
  const named = settings.named_brains.brains;
  const find = (n: string | null | undefined) => (n ? named.find((b) => b.name.toLowerCase() === n.trim().toLowerCase()) : undefined);
  if (asked) {
    const b = find(asked);
    if (!b) {
      throw new Error(
        named.length
          ? `There's no brain called "${asked}". The brains are: ${named.map((x) => x.name).join(", ")}.`
          : `There are no named brains yet, so helpers use the main one. Leave out brain.`,
      );
    }
    return { name: b.name, chain: b.chain };
  }
  const b = find((settings.named_brains.uses as Record<string, string | null>)[kind]);
  return b ? { name: b.name, chain: b.chain } : { name: "Main", chain: settings.brains.main };
}
