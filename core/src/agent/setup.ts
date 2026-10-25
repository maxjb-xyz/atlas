// Setup (VISION §22): a passkey, meeting Atlas, a brain, a calendar,
// Atlas's first look, and the default routines. Every step can be skipped and picked up
// again from settings, so setup only records which steps are done.

import type { Sql } from "../store/db";
import { getState, setState } from "../store/state";

export const SETUP_STEPS = ["passkey", "meet", "brain", "connect", "look", "routines", "movein"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Moving in (§22 step 7) is the last step and an optional one: setup is
 * finished without it, so an Atlas set up before it was a step doesn't open
 * on setup again, and it's picked up any time from Library.
 */
const OPTIONAL: SetupStep[] = ["movein"];

export interface SetupView {
  done: SetupStep[];
  skipped: SetupStep[];
  /** True once every step but the optional ones is done or skipped: the app stops opening on setup. */
  finished: boolean;
}

export function setupView(sql: Sql): SetupView {
  const s = getState<{ done?: SetupStep[]; skipped?: SetupStep[] }>(sql, "setup") ?? {};
  const done = (s.done ?? []).filter((x) => SETUP_STEPS.includes(x));
  const skipped = (s.skipped ?? []).filter((x) => SETUP_STEPS.includes(x) && !done.includes(x));
  return {
    done,
    skipped,
    finished: SETUP_STEPS.every((x) => OPTIONAL.includes(x) || done.includes(x) || skipped.includes(x)),
  };
}

export function markStep(sql: Sql, step: SetupStep, state: "done" | "skipped" | "open"): SetupView {
  const v = setupView(sql);
  const done = v.done.filter((x) => x !== step);
  const skipped = v.skipped.filter((x) => x !== step);
  if (state === "done") done.push(step);
  if (state === "skipped") skipped.push(step);
  setState(sql, "setup", { done, skipped });
  return setupView(sql);
}

// --- the voice picker (step 2) -------------------------------------------------------

export interface VoiceOption {
  id: string;
  name: string;
  /** A short public sample the app can play before choosing. */
  preview_url: string | null;
  description: string;
}

/** The voices this ElevenLabs key can use, with their samples. */
export async function elevenLabsVoices(key: string, f: typeof fetch): Promise<VoiceOption[]> {
  const res = await f("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": key } });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`ElevenLabs answered ${res.status} for the voice list at api.elevenlabs.io${body ? `: ${body}` : ""}`);
  }
  const data = (await res.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      preview_url?: string | null;
      description?: string | null;
      labels?: Record<string, string>;
    }>;
  };
  return (data.voices ?? [])
    .filter((v) => v.voice_id && v.name)
    .map((v) => ({
      id: v.voice_id!,
      name: v.name!,
      preview_url: v.preview_url ?? null,
      description: v.description || Object.values(v.labels ?? {}).join(", "),
    }));
}

// --- Atlas's first look (step 5) -----------------------------------------------------

export interface FirstLook {
  areas: Array<{ name: string; about: string }>;
  people: Array<{ name: string; why: string }>;
  notes: string[];
}

export const LOOK_NOTE = `[Setup, not the owner] This is your first look at the owner's world. Read their calendar from today through the next two weeks with calendar_read, and recall anything you already know. Then propose:
- the areas of their life you can see (a job, a business, school, family, health, a hobby), each with one short sentence;
- the key people, each with why they matter;
- three to five things worth knowing about the next two weeks, the way you'd mention them ("Two clashes on Thursday", "Your 9 am Friday has no travel time").
Only what the calendar and what you know actually show; fewer is fine. Reply with JSON only: {"areas": [{"name": "...", "about": "..."}], "people": [{"name": "...", "why": "..."}], "notes": ["..."]}`;

/** Reads the brain's proposal. What doesn't parse is left out, not guessed. */
export function parseLook(text: string): FirstLook | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const d = JSON.parse(text.slice(start, end + 1)) as { areas?: unknown; people?: unknown; notes?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    return {
      areas: list(d.areas)
        .filter((a): a is { name: string; about?: unknown } => typeof (a as { name?: unknown })?.name === "string")
        .map((a) => ({ name: a.name.slice(0, 60), about: typeof a.about === "string" ? a.about.slice(0, 300) : "" }))
        .slice(0, 12),
      people: list(d.people)
        .filter((p): p is { name: string; why?: unknown } => typeof (p as { name?: unknown })?.name === "string")
        .map((p) => ({ name: p.name.slice(0, 80), why: typeof p.why === "string" ? p.why.slice(0, 300) : "" }))
        .slice(0, 20),
      notes: list(d.notes)
        .filter((n): n is string => typeof n === "string")
        .map((n) => n.slice(0, 300))
        .slice(0, 5),
    };
  } catch {
    return null;
  }
}
