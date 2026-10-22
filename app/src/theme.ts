// Themes (§21.9): Graphite (dark) and Daylight (light). A device follows the
// system's light or dark setting unless the owner picks one; the choice and
// reduced motion are kept per device.

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "graphite" | "daylight";
export type MotionChoice = "full" | "reduced";

const KEY = "atlas.look";

interface Look {
  theme: ThemeChoice;
  motion: MotionChoice;
}

function read(): Look {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
    return { theme: v.theme ?? "system", motion: v.motion ?? "full" };
  } catch {
    return { theme: "system", motion: "full" };
  }
}

function apply(look: Look): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = look.theme === "system" ? (dark ? "graphite" : "daylight") : look.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.motion = look.motion;
}

/** Applies the device's look now and whenever the system theme changes. */
export function startLook(): void {
  apply(read());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => apply(read()));
}

export function useLook(): [Look, (patch: Partial<Look>) => void] {
  const [look, setLook] = useState(read);
  useEffect(() => apply(look), [look]);
  const update = (patch: Partial<Look>) => {
    const next = { ...look, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private windows can refuse storage; the look still applies for this visit.
    }
    setLook(next);
  };
  return [look, update];
}
