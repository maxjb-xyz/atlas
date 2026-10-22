// The default routines (§13.4): a morning brief, an evening wrap-up and a
// weekly review, made once as ordinary automations the owner can change,
// turn on or delete. They start off; setup's last step offers each one with
// its time (§22). Each is one Atlas step with a note, so what it says comes
// from the calendar, the agenda and what was said, looked up when it runs.

import { type AutomationInput, listAutomations, saveAutomation } from "./automations";
import type { Sql } from "./store/db";
import { getState, setState } from "./store/state";

export const ROUTINES: AutomationInput[] = [
  {
    name: "Morning brief",
    about: "A default routine: what today holds, each morning.",
    when: { kind: "schedule", at: "08:00", days: [] },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Give the owner their morning brief for today.",
          "Read today's calendar with calendar_read, and look at the reminders and promises due today in your context.",
          "Say what today holds in order, flag anything that clashes or needs getting ready for, and end with the one thing most worth doing first.",
          "If the calendar can't be read, say so in a line and carry on with the rest. If nothing is on, say so in a sentence.",
          "Keep it short enough to read in half a minute.",
        ].join(" "),
      },
    ],
    report: "thread",
  },
  {
    name: "Evening wrap-up",
    about: "A default routine: how today went and what tomorrow starts with.",
    when: { kind: "schedule", at: "21:00", days: [] },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Wrap up the owner's day.",
          "Use recall for what was said and done today, and look at tomorrow's calendar and the reminders and promises due tomorrow.",
          "In a few lines: what got done or decided today, what's still open, and what tomorrow starts with. Pick what matters rather than listing everything.",
          "If today was quiet, say so in a sentence.",
        ].join(" "),
      },
    ],
    report: "thread",
  },
  {
    name: "Weekly review",
    about: "A default routine: the week behind and the week ahead, on Sunday evenings.",
    when: { kind: "schedule", at: "18:00", days: [0] },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Give the owner their weekly review.",
          "Use recall for the past seven days, area by area where that helps, and read the coming week's calendar.",
          "Say what moved forward this week, what slipped or is still waiting (promises, things they said they'd do), and what the coming week holds, with anything to get ready for.",
          "End with one question about what matters most next week. Keep it to what fits on one screen.",
        ].join(" "),
      },
    ],
    report: "thread",
  },
];

/**
 * Makes the default routines once per deployment. A routine the owner
 * deleted stays deleted, and a name they already use is left alone (they
 * made their own). Returns the ids it made, for arming.
 */
export function seedRoutines(sql: Sql): string[] {
  if (getState(sql, "routines")) return [];
  const taken = new Set(listAutomations(sql).map((a) => a.name.toLowerCase()));
  const made = ROUTINES.filter((r) => !taken.has(r.name.toLowerCase())).map((r) => saveAutomation(sql, r, "default").id);
  setState(sql, "routines", { made_at: Date.now(), ids: made });
  return made;
}
