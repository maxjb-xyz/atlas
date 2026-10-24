// Themes (§21.9) and the detail level (§21.5), kept per device. A device
// follows the system's light or dark setting unless the owner picks a theme;
// the detail level starts at Simple, and one switch changes it everywhere.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "graphite" | "daylight";
export type MotionChoice = "full" | "reduced";
/** How much the app shows (§21.5): plain words, steps as they run, or every id, model and number. */
export type Detail = "simple" | "detailed" | "developer";

const KEY = "atlas.look";

export interface Look {
  theme: ThemeChoice;
  motion: MotionChoice;
  detail: Detail;
}

function read(): Look {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
    return {
      theme: v.theme ?? "system",
      motion: v.motion ?? "full",
      detail: v.detail === "detailed" || v.detail === "developer" ? v.detail : "simple",
    };
  } catch {
    return { theme: "system", motion: "full", detail: "simple" };
  }
}

let current = read();
const listeners = new Set<() => void>();

function apply(look: Look): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = look.theme === "system" ? (dark ? "graphite" : "daylight") : look.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.motion = look.motion;
  document.documentElement.dataset.detail = look.detail;
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
