// What a job is doing right now, as the app shows it (§21.4). A job that hasn't
// ended is shown as running only while something is at work on it: a look, or a
// step's helper or coding agent. Waiting on the owner, paused, or stalled is
// said as that, with how long since it last moved.

import type { JobView } from "../../core/src/protocol";

export interface JobNow {
  /** A word or two: Running, Waiting on you, Paused, Stalled, Done, Failed, Stopped. */
  label: string;
  /** The class its label is shown in. */
  tone: "ac" | "ok" | "err" | "muted";
  /** Something is at work on it: it gets the spinner. */
  live: boolean;
  /** What it's doing, or why it isn't. */
  status: string;
}

function since(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export function jobNow(j: JobView, now = Date.now()): JobNow {
  if (j.state === "done") return { label: "Done", tone: "ok", live: false, status: "Finished" };
  if (j.state === "failed") return { label: "Failed", tone: "err", live: false, status: "Didn't finish" };
  if (j.state === "cancelled") return { label: "Stopped", tone: "muted", live: false, status: "Stopped" };
  // Between one move and its next look: past the moment it should have taken, with no news, it has stalled.
  const stalled = j.activity === "stalled" || (j.activity === "working" && j.quiet_until != null && now > j.quiet_until);
  if (stalled) {
    const moved = j.moved_at ? ` in ${since(now - j.moved_at)}` : "";
    return {
      label: "Stalled",
      tone: "err",
      live: false,
      status: j.activity === "stalled" ? (j.status ?? `Nothing has happened${moved}.`) : `Not moving: nothing has happened${moved}.`,
    };
  }
  if (j.activity === "waiting") return { label: "Waiting on you", tone: "muted", live: false, status: j.status ?? "Waiting for you." };
  if (j.activity === "paused") return { label: "Paused", tone: "muted", live: false, status: j.status ?? "Paused." };
  return { label: "Running", tone: "ac", live: true, status: j.status ?? "Working" };
}

/** The jobs something is at work on right now. */
export const liveJobs = (jobs: JobView[], now = Date.now()) => jobs.filter((j) => !j.part_of && jobNow(j, now).live);
