// Skills (§9.3) as Atlas reaches them. The index of every skill's one-line
// description is in each run's context; skill_read opens one before a task
// it covers. After a task that took working out and that the owner was
// happy with, Atlas writes down how with skill_save, including what went
// wrong, and the owner sees "Learned a skill · …" with Undo.

import { z } from "zod";
import { ensureSkillChecks, findSkill, listSkills, noteCheck, noteUse, saveSkill, setSkillState } from "../skills";
import { defineTool, fail } from "./types";

export const skillRead = defineTool({
  name: "skill_read",
  kind: "look",
  description:
    "Open one of your skills by name, before doing a task it covers: the list in your context has each one's name and what it's for. Follow it, and improve it with skill_save if it turns out wrong or incomplete.",
  input: z.object({ name: z.string().min(1).max(80) }),
  async run(input, ctx) {
    const s = findSkill(ctx.sql, input.name);
    if (!s) {
      const names = listSkills(ctx.sql).map((x) => x.name);
      return fail(
        names.length ? `There's no skill called "${input.name}". You have: ${names.join(", ")}.` : "You haven't learned any skills yet.",
      );
    }
    noteUse(ctx.sql, s.id);
    // An archived skill comes back into the index when it's used again (§9.3: archived, never deleted).
    if (s.state === "archived") setSkillState(ctx.sql, s.id, "active", "atlas", "Used again.");
    return {
      ok: true,
      output: {
        name: s.name,
        description: s.description,
        version: s.version,
        instructions: s.body,
        ...(s.check ? { check: s.check } : {}),
        ...(s.checked && !s.checked.ok ? { broken: `Its last check failed: ${s.checked.output.slice(-500)}` } : {}),
      },
    };
  },
});

export const skillSave = defineTool({
  name: "skill_save",
  kind: "change_own",
  status: "Writing down how.",
  description: [
    "Write down how to do something, as a skill you'll find again next time. Use it after a task that took several steps or some working out, once the owner was happy with the result (they thanked you, accepted it, or used it); and to improve a skill you followed that was wrong or incomplete (same name: it becomes a new version, with a note on what changed).",
    "`description` is the line your index shows: what it's for and when to use it. `body` is the steps, in Markdown: what to do, in order, which tools, and what went wrong along the way and how you got past it. Keep the owner's private details out unless the skill needs them.",
    "`check` is optional: a shell command, run in the workspace, that exits 0 while the skill still works (a weekly pass runs it).",
    "Don't save one-off tasks, or what an existing skill already covers.",
  ].join(" "),
  input: z.object({
    name: z.string().min(3).max(64).describe("Short, lowercase words with hyphens: 'file-reimbursements'."),
    description: z.string().min(10).max(300),
    body: z.string().min(20).max(20_000),
    check: z.string().max(2_000).optional(),
    note: z.string().max(300).optional().describe("For a change: what changed and why."),
  }),
  async run(input, ctx) {
    try {
      const { skill, change } = saveSkill(ctx.sql, { ...input, by: "atlas", run_id: ctx.run_id });
      if (change === "same") return { ok: true, output: { unchanged: skill.name, note: "That's what the skill already says." } };
      const checks = skill.check ? ensureSkillChecks(ctx.sql) : null;
      if (checks) await ctx.clock.schedule(checks);
      return {
        ok: true,
        output: { saved: skill.name, version: skill.version, change },
        receipt: {
          text: change === "made" ? `Learned a skill · ${skill.name}` : `Improved a skill · ${skill.name} · version ${skill.version}`,
          undo: { kind: "skill.undo", id: skill.id, version: skill.version },
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const skillCheck = defineTool({
  name: "skill_check",
  kind: "change_own",
  status: "Checking that skill still works.",
  timeoutMs: 5 * 60_000,
  description: "Run a skill's check in the workspace now, to see whether it still works.",
  input: z.object({ name: z.string().min(1).max(80) }),
  async run(input, ctx) {
    const s = findSkill(ctx.sql, input.name);
    if (!s) return fail(`There's no skill called "${input.name}".`);
    if (!s.check) return fail(`${s.name} has no check. Add one with skill_save.`);
    if (!ctx.workspace) return fail("The workspace can't be used from here.");
    try {
      const r = await ctx.workspace.run(s.check, { run_id: ctx.run_id, timeout_s: 120 });
      noteCheck(ctx.sql, s.id, { ok: r.exit === 0, output: r.output });
      return { ok: true, output: { name: s.name, passed: r.exit === 0, exit: r.exit, output: r.output.slice(-3_000) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const skillTools = [skillRead, skillSave, skillCheck];
