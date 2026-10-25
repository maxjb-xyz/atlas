// Atlas's settings by asking (§21): "don't call me before 9", "let the
// workspace reach any site", "use Claude for voice". Each setting the owner
// can change in Atlas settings can be changed here by name, checked against
// the same schema, with Undo on the receipt. Only the owner's own runs have
// these tools. Loosening a permission (§12.3), or rewriting the character's
// notes, isn't done from a run that has read the web (§20): what it read
// could be steering it.

import { z } from "zod";
import { readSettings, Settings, type SettingsPatch } from "../store/settings";
import { defineTool, fail } from "./types";

/** Each setting Atlas can change, by its path, with what it means and what it takes. */
export const SETTABLE: Record<string, string> = {
  assistant_name: "your name, as the owner calls you",
  owner_name: "the owner's name",
  timezone: "the owner's time zone, like America/New_York",
  units: "auto, us or metric",
  "notifications.push": "true or false: notifications to the device used last when no app is open",
  "notifications.quiet.on": "true or false: quiet hours, when what can wait is held",
  "notifications.quiet.from": "when quiet hours start, HH:mm",
  "notifications.quiet.to": "when quiet hours end, HH:mm",
  "notifications.budget": "how many interruptions a day for what can wait (0 for no limit)",
  "notifications.lists.now": 'where what can\'t wait goes, in order: "push", "call", or a linked chat\'s id ("telegram")',
  "notifications.lists.soon": "where what can wait goes, in order, the same way",
  "permissions.outside": "outside actions without their own rule: always, until_trusted or never (asking)",
  "permissions.sites": "websites the workspace reaches: each (asks for each) or any",
  "permissions.forms": "forms in the browser: ask or allowed_sites",
  "permissions.after_web": "after reading the web, before anything leaves: ask or trusted (what's trusted goes)",
  "permissions.email_as_you": "mail sent as the owner: per_recipient (asks until trusted) or always",
  "permissions.faces_known": "faces replying to people Atlas knows: until_trusted or send",
  "permissions.mcp": "connected services' tools: per_tool or per_service trust",
  "permissions.device_tools": "tools on the owner's devices: until_trusted or always",
  "permissions.calls": "phone calls to the owner: never or urgent",
  "character.preset": "atlas, butler, coach, friend or quiet",
  "character.warmth": "1 to 5",
  "character.humor": "1 to 5",
  "character.directness": "1 to 5",
  "character.initiative": "1 to 5",
  "character.notes": "anything else about how you are, in the owner's words",
  "voice.speech_in": "workers-ai-flux or elevenlabs-scribe",
  "voice.speech_out": "elevenlabs or workers-ai-aura",
  "voice.elevenlabs_voice_id": "the ElevenLabs voice's id",
  "brains.main": 'the main brain chain, first answers: a list of { "provider": "chatgpt" | "workers-ai" | "anthropic", "model": "..." }',
  "brains.voice": "the voice brain chain, the same way",
  "web.search": "which web search: cloudflare, or a search extension's id",
  "maps.provider": "which maps: osm, or a maps extension's id",
  "location.on": "true or false: whether Atlas takes in where the owner is",
  "calendar.hidden": "calendar names Atlas leaves out, a list",
  "speaking.noticing": "true or false: whether Atlas speaks up about what it notices",
  "speaking.leave": "true or false: when-to-leave notes before events with a place",
};

/** For each permission, its values from most careful to least: moving right loosens it. */
const LOOSER: Record<string, string[]> = {
  outside: ["always", "until_trusted", "never"],
  sites: ["each", "any"],
  forms: ["ask", "allowed_sites"],
  after_web: ["ask", "trusted"],
  email_as_you: ["always", "per_recipient"],
  faces_known: ["until_trusted", "send"],
  mcp: ["per_tool", "per_service"],
  device_tools: ["always", "until_trusted"],
  calls: ["never", "urgent"],
};

/** Whether a change loosens a permission, or rewrites the character's own notes: not from a run that read the web. */
export function guarded(path: string, before: unknown, after: unknown): boolean {
  if (path === "character.notes") return before !== after;
  const [root, rule] = path.split(".");
  if (root !== "permissions" || !rule || !LOOSER[rule]) return false;
  return LOOSER[rule]!.indexOf(String(after)) > LOOSER[rule]!.indexOf(String(before));
}

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);

/** The settings with one value changed at a path, as a patch of its top-level setting. */
function withValue(all: Settings, path: string, value: unknown): SettingsPatch {
  const [root, ...rest] = path.split(".");
  if (!rest.length) return { [root!]: value } as SettingsPatch;
  const top = structuredClone((all as Record<string, unknown>)[root!]) as Record<string, unknown>;
  let at = top;
  for (const k of rest.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[rest.at(-1)!] = value;
  return { [root!]: top } as SettingsPatch;
}

export const settingsLook = defineTool({
  name: "settings_look",
  kind: "look",
  status: "Checking your settings.",
  description:
    "Your settings as they are now, each by the name settings_change takes, with what it means: notifications and quiet hours, the owner's rules for when you ask (permissions), your character, voice, brains, search, maps, location, and the rest.",
  input: z.object({}),
  async run(_input, ctx) {
    const s = readSettings(ctx.sql);
    return {
      ok: true,
      output: { settings: Object.fromEntries(Object.entries(SETTABLE).map(([p, about]) => [p, { now: get(s, p), about }])) },
    };
  },
});

export const settingsChange = defineTool({
  name: "settings_change",
  kind: "change_own",
  status: "Changing that setting.",
  description: [
    "Change your own settings when the owner asks ('don't notify me before 9', 'let the workspace reach any site', 'be more direct', 'use Claude for voice'): each change by its name and new value, as settings_look shows them. It's done at once, with Undo on the receipt; tell them what changed in a sentence.",
    "Loosening one of the owner's rules for when you ask, or rewriting your character's notes, isn't done once this run has read the web: say so, and that they can ask again in a new message or change it in Atlas settings.",
    "What isn't here is set in the app: say where. The owner's own phone numbers, keys and sign-ins are only set there.",
  ].join(" "),
  input: z.object({
    changes: z
      .array(
        z.object({
          setting: z.string().min(1).max(60).describe("Its name, like notifications.quiet.from or permissions.sites."),
          value: z.unknown().describe("Its new value, as settings_look shows the kind."),
        }),
      )
      .min(1)
      .max(10),
  }),
  async run(input, ctx) {
    if (!ctx.settingsEdit) return fail("Settings can only be changed when the owner asks.");
    const before = readSettings(ctx.sql);
    let next: Settings = before;
    let patch: SettingsPatch = {};
    const said: string[] = [];
    for (const c of input.changes) {
      if (!(c.setting in SETTABLE))
        return fail(`There's no setting "${c.setting}" you can change. settings_look lists them; anything else is set in the app.`);
      const was = get(next, c.setting);
      if (guarded(c.setting, was, c.value) && ctx.settingsEdit.readWeb())
        return fail(
          `${c.setting} would loosen what the owner set, and this run has read the web, which could be steering it. They can ask again in a new message, or change it in Atlas settings.`,
        );
      const p = withValue(next, c.setting, c.value);
      const parsed = Settings.safeParse({ ...next, ...p });
      if (!parsed.success)
        return fail(
          `${c.setting} can't be ${JSON.stringify(c.value)}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      next = parsed.data;
      patch = { ...patch, ...p };
      said.push(`${c.setting}: ${JSON.stringify(was)} → ${JSON.stringify(c.value)}`);
    }
    const out = ctx.settingsEdit.change(patch);
    if (!out.ok) return fail(out.text);
    const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, (before as Record<string, unknown>)[k]])) as SettingsPatch;
    return {
      ok: true,
      output: { changed: said },
      receipt: {
        text: `Changed ${input.changes.map((c) => c.setting).join(", ")}`,
        undo: { kind: "settings.restore", before: undo as never },
      },
    };
  },
});

export const settingsTools = [settingsLook, settingsChange];
