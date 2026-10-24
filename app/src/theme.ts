// Themes (§21.9) and the detail level (§21.5), kept per device. A device
// follows the system's light or dark setting unless the owner picks a theme;
// the detail level starts at Simple, and one switch changes it everywhere.

import { useSyncExternalStore } from "react";

/** The built-in themes (§21.9), and whether each is dark or light. */
export const THEME_TONE = { graphite: "dark", daylight: "light", terminal: "dark", midnight: "dark", "high-contrast": "dark" } as const;
export type BuiltIn = keyof typeof THEME_TONE;
/** "system" follows the system's light or dark; "custom" is the owner's own theme file, which does too. */
export type ThemeChoice = "system" | "custom" | BuiltIn;

/**
 * A theme file of the owner's own: a name, and tokens for dark and for light
 * (any of --bg, --tx, --ac and the rest), laid over Graphite or Daylight.
 */
export interface CustomTheme {
  name: string;
  dark: Record<string, string>;
  light: Record<string, string>;
}

/** The tokens a theme file may set, and what a value may be: a color, written as CSS writes one. */
export const TOKENS = [
  "bg",
  "win",
  "side",
  "sep",
  "sep2",
  "dash",
  "hover",
  "sel",
  "tx",
  "tx2",
  "tx3",
  "ac",
  "acs",
  "dot",
  "btn",
  "btntx",
  "m1",
  "m2",
  "m3",
  "m4",
  "ok",
  "bad",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "d1",
  "d2",
  "d3",
  "d4",
] as const;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

/** A theme file read and checked: its tokens, each a color. Throws with what's wrong. */
export function readTheme(text: string): CustomTheme {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('That isn\'t a theme file: it should be JSON, like {"name": "Mine", "dark": {"ac": "#4cc48f"}}.');
  }
  const o = v as { name?: unknown; dark?: unknown; light?: unknown };
  const side = (x: unknown, which: string): Record<string, string> => {
    if (x == null) return {};
    if (typeof x !== "object") throw new Error(`"${which}" should be a set of tokens.`);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      const name = k.replace(/^--/, "");
      if (!(TOKENS as readonly string[]).includes(name)) throw new Error(`"${k}" isn't a theme token. They are: ${TOKENS.join(", ")}.`);
      if (typeof val !== "string" || !COLOR.test(val.trim())) throw new Error(`"${k}" in "${which}" should be a color, like #ff6a3d.`);
      out[name] = val.trim();
    }
    return out;
  };
  const theme = {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : "My theme",
    dark: side(o.dark, "dark"),
    light: side(o.light, "light"),
  };
  if (!Object.keys(theme.dark).length && !Object.keys(theme.light).length) throw new Error('A theme file needs "dark" or "light" tokens.');
  return theme;
}
export type MotionChoice = "full" | "reduced";
/** How much the app shows (§21.5): plain words, steps as they run, or every id, model and number. */
export type Detail = "simple" | "detailed" | "developer";

const KEY = "atlas.look";

export interface Look {
  theme: ThemeChoice;
  /** The owner's own theme file, when they've added one. */
  custom?: CustomTheme;
  motion: MotionChoice;
  detail: Detail;
}

function read(): Look {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
    return {
      theme: v.theme && (v.theme === "system" || v.theme === "custom" || v.theme in THEME_TONE) ? v.theme : "system",
      ...(v.custom ? { custom: v.custom } : {}),
      motion: v.motion ?? "full",
      detail: v.detail === "detailed" || v.detail === "developer" ? v.detail : "simple",
    };
  } catch {
    return { theme: "system", motion: "full", detail: "simple" };
  }
}

let current = read();
const listeners = new Set<() => void>();

/** The theme a look comes to now: a built-in one, with the custom file's tokens laid over it when it's chosen. */
export function themeNow(look: Look): BuiltIn {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return look.theme === "system" || look.theme === "custom" ? (dark ? "graphite" : "daylight") : look.theme;
}

function apply(look: Look): void {
  const theme = themeNow(look);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.tone = THEME_TONE[theme];
  // The owner's own file follows the system too: its dark tokens at night, its light ones by day.
  const over = look.theme === "custom" && look.custom ? look.custom[THEME_TONE[theme] === "dark" ? "dark" : "light"] : {};
  for (const t of TOKENS) {
    if (over[t]) root.style.setProperty(`--${t}`, over[t]!);
    else root.style.removeProperty(`--${t}`);
  }
  root.dataset.motion = look.motion;
  root.dataset.detail = look.detail;
}

/** Applies the device's look now and whenever the system theme changes. */
export function startLook(): void {
  apply(current);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    apply(current);
    for (const l of listeners) l();
  });
}

function setLook(patch: Partial<Look>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private windows can refuse storage; the look still applies for this visit.
  }
  apply(current);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLook(): [Look, (patch: Partial<Look>) => void] {
  const look = useSyncExternalStore(subscribe, () => current);
  return [look, setLook];
}

/** The detail level, with a check for "at least this much": `at("developer")`. */
export function useDetail(): { detail: Detail; at: (d: Detail) => boolean; set: (d: Detail) => void } {
  const [look] = useLook();
  const order: Detail[] = ["simple", "detailed", "developer"];
  return { detail: look.detail, at: (d) => order.indexOf(look.detail) >= order.indexOf(d), set: (detail) => setLook({ detail }) };
}

/** Whether things should stay still: the owner's choice here, or the system's. */
export const stillMotion = () =>
  document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
