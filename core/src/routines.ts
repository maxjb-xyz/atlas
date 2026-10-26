// The default routines (§13.4): a morning brief, an evening wrap-up and a
// weekly review, made once as ordinary automations the owner can change,
// turn on or delete. They are Atlas's looks at the day: the morning brief
// and the evening wrap-up report only when there's something worth saying,
// and see the later pile and what was already said, like any Atlas step.
// The morning brief starts on, since it stays quiet on a quiet day; the
// others start off, and setup offers each with its time (§22).

import { type AutomationInput, getAutomation, listAutomations, saveAutomation, setAutomationState } from "./automations";
import { parse, type Sql } from "./store/db";
import { getState, setState } from "./store/state";

export const ROUTINES: AutomationInput[] = [
  {
    name: "Morning brief",
    about: "A default routine: a look at the day ahead each morning, which stays quiet when there's nothing worth saying.",
    when: { kind: "schedule", at: "08:00", days: [] },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Look at the owner's day ahead, the way a great assistant would at the start of it.",
          "Read today's calendar with calendar_read, and look at the situation, the reminders and promises due today, the open tasks, what came in overnight, and the weather.",
          "If there's something they'd be glad to hear now (what today holds and when to leave, a clash, something to get ready, rain before a walk, a task that fits the day), tell them in a few lines, readable in half a minute, ending with the one thing most worth doing first.",
          "If the day is empty and nothing came in that matters, stay quiet.",
        ].join(" "),
      },
    ],
    report: "worth",
  },
  {
    name: "Evening wrap-up",
    about: "A default routine: how today went and what tomorrow starts with, when there's something worth saying.",
    when: { kind: "schedule", at: "21:00", days: [] },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Look back at the owner's day and ahead to tomorrow.",
          "Use recall for what was said and done today, and look at tomorrow's calendar, the reminders and promises due tomorrow, and what came in today that could wait.",
          "If something is worth telling them tonight (something left undone, an early start or something to get ready tomorrow), say it in a few lines, picking what matters rather than listing everything.",
          "If today was quiet and tomorrow needs nothing from tonight, stay quiet.",
        ].join(" "),
      },
    ],
    report: "worth",
  },
  {
    name: "Check-ins",
    about:
      "A default routine: a quick look a few times a day at what changed, which says something only when it's worth it. Each look is one short turn on your main brain.",
    when: { kind: "schedule", at: "10:00", days: [], every_hours: 3, until: "19:00" },
    do: [
      {
        kind: "atlas",
        instructions: [
          "Take a quick look at what changed for the owner since your last look, the way a great assistant glances up between tasks.",
          "Look at the calendar's next few hours (a clash, something moved, when to leave given where they are), what came in that could wait, open tasks that fit where they are or what's next, work of yours waiting on them, and the weather if something outdoors is coming up.",
          "If there's one thing they'd want to know now, tell them in a line or two, the way you'd lean over and say it: lead with it, no greeting, no recap of what they already know.",
          "Most looks find nothing worth saying, and then you stay quiet. Never repeat what you or another routine already told them today.",
        ].join(" "),
      },
    ],
    report: "worth",
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
  const kept = getState<{ made_at: number; ids: string[]; v?: number }>(sql, "routines");
  if (kept) {
    if ((kept.v ?? 1) < 2) upgrade(sql, kept);
    if ((kept.v ?? 1) < 3) return addCheckIns(sql);
    return [];
  }
  const taken = new Set(listAutomations(sql).map((a) => a.name.toLowerCase()));
  const made = ROUTINES.filter((r) => !taken.has(r.name.toLowerCase())).map((r) => saveAutomation(sql, r, "default").id);
  for (const id of made) if (getAutomation(sql, id)?.name === "Morning brief") setAutomationState(sql, id, true, "atlas");
  setState(sql, "routines", { made_at: Date.now(), ids: made, v: 3 });
  return made;
}

/**
 * Once, on a deployment made before check-ins (2026-10-26): adds them, off like every routine but the morning brief,
 * unless the owner already has an automation by that name.
 */
function addCheckIns(sql: Sql): string[] {
  const kept = getState<{ made_at: number; ids: string[]; v?: number }>(sql, "routines")!;
  const taken = listAutomations(sql).some((a) => a.name.toLowerCase() === "check-ins");
  const routine = ROUTINES.find((r) => r.name === "Check-ins")!;
  const made = taken ? [] : [saveAutomation(sql, routine, "default").id];
  setState(sql, "routines", { ...kept, ids: [...kept.ids, ...made], v: 3 });
  return made;
}

/**
 * Once, on a deployment made before the daily looks were routines
 * (2026-10-23): the morning brief and the evening wrap-up the owner hasn't
 * rewritten get their new steps and report, and take over the start of
 * day and evening looks, with their times and whether they were on. The
 * looks' own items on the clock end.
 */
function upgrade(sql: Sql, kept: { made_at: number; ids: string[] }): void {
  const raw = sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'speaking'`).toArray()[0];
  const old = parse<{ morning?: { on?: boolean; at?: string }; evening?: { on?: boolean; at?: string } }>(raw?.value, {});
  const looks = {
    "Morning brief": { on: old.morning?.on ?? true, at: old.morning?.at },
    "Evening wrap-up": { on: old.evening?.on ?? false, at: old.evening?.at },
  };
  for (const id of kept.ids) {
    const a = getAutomation(sql, id);
    const fresh = ROUTINES.find((r) => r.name === a?.name);
    if (!a || !fresh || a.made_by !== "default" || !(a.name in looks)) continue;
    // A routine whose steps the owner rewrote keeps them; its report and time are theirs too.
    const original = a.do.length === 1 && a.do[0]!.kind === "atlas" && a.report === "thread";
    if (!original) continue;
    const look = looks[a.name as keyof typeof looks];
    // A look that was off never had its time chosen, so the routine keeps its own.
    const at = look.on && look.at && /^\d\d:\d\d$/.test(look.at) ? look.at : a.when.kind === "schedule" ? a.when.at : "08:00";
    saveAutomation(sql, { ...fresh, when: { kind: "schedule", at, days: [] } }, "default", a.id);
    if (look.on && a.state !== "on") setAutomationState(sql, a.id, true, "atlas");
  }
  sql.exec(
    `UPDATE agenda SET state = 'cancelled', updated_at = ? WHERE kind = 'rhythm' AND state = 'scheduled' AND json_extract(source, '$.detail.moment') IN ('morning', 'evening')`,
    Date.now(),
  );
  setState(sql, "routines", { ...kept, v: 2 });
}
