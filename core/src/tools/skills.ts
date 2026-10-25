// Skills (§9.3) as Atlas reaches them. The index of every skill's one-line
// description is in each run's context; skill_read opens one before a task
// it covers, and skill_file one of the files in its folder. skill_save
// writes down how, or improves a skill with a patch that replaces only the
// passage that was wrong; a new skill that reads like one Atlas already has
// is refused with that skill's name, so there's one skill per method. Most
// skills are saved by the review that looks back over a conversation once
// it goes quiet (agent.ts), which also has skill_merge; the owner sees
// "Learned a skill · …" or "Improved a skill · …" with Undo.

import { z } from "zod";
import {
  ensureSkillChecks,
  FILE_PATH,
  findSkill,
  listSkills,
  meaningOf,
  nearestSkill,
  noteCheck,
  noteUse,
  patchBody,
  SAME_METHOD,
  saveSkill,
  setSkillFiles,
  setSkillState,
  setSkillVec,
  type Skill,
  type SkillFile,
  skillFileKey,
  skillMdBytes,
  skillSources,
} from "../skills";
import type { Sql } from "../store/db";
import { defineTool, fail, type ToolContext, type WorkspaceApi } from "./types";

/** The most a skill's file may hold, as text. */
const MAX_FILE = 100_000;

/** Takes and keeps a skill's meaning, so a later near-duplicate is caught. Quietly does nothing without an embedder. */
async function remember(ctx: ToolContext, s: Skill): Promise<void> {
  if (!ctx.embed) return;
  try {
    const [v] = await ctx.embed.embed([meaningOf(s)]);
    if (v) setSkillVec(ctx.sql, s.id, ctx.embed.model, v);
  } catch (err) {
    console.error(JSON.stringify({ at: "skills.embed", skill: s.name, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Puts a skill's folder in the workspace, at /workspace/skills/<name>, as
 * the standard lays it out (its SKILL.md and every file), so its scripts can
 * run there: before its check, and when Atlas asks. Small files go a few to
 * a command; a big one goes in pieces.
 */
export async function unpackSkill(ws: WorkspaceApi, sql: Sql, files: R2Bucket | null, s: Skill, runId: string): Promise<string> {
  const dir = `/workspace/skills/${s.name}`;
  const run = async (command: string) => {
    const r = await ws.run(command, { run_id: runId, timeout_s: 60 });
    if (r.exit !== 0) throw new Error(`Couldn't put ${s.name}'s folder in the workspace: ${r.output.slice(-500)}`);
  };
  let batch: string[] = [`rm -rf ${dir} && mkdir -p ${dir}`];
  let size = 0;
  const flush = async () => {
    if (batch.length) await run(batch.join(" && "));
    batch = [];
    size = 0;
  };
  const put = async (path: string, bytes: Uint8Array) => {
    const b64 = toBase64(bytes);
    const slash = path.lastIndexOf("/");
    const mkdir = slash > 0 ? `mkdir -p ${dir}/${path.slice(0, slash)} && ` : "";
    const done = `base64 -d ${dir}/${path}.b64 > ${dir}/${path} && rm ${dir}/${path}.b64${path.startsWith("scripts/") ? ` && chmod +x ${dir}/${path}` : ""}`;
    // One shell argument can't be longer than 128 KB, and a command is one argument: a batch stays under half that.
    if (b64.length <= UNPACK_CHUNK) {
      const cmd = `${mkdir}printf %s '${b64}' > ${dir}/${path}.b64 && ${done}`;
      if (size + cmd.length > UNPACK_CHUNK) await flush();
      batch.push(cmd);
      size += cmd.length;
      return;
    }
    await flush();
    await run(`${mkdir}: > ${dir}/${path}.b64`);
    for (let i = 0; i < b64.length; i += UNPACK_CHUNK) await run(`printf %s '${b64.slice(i, i + UNPACK_CHUNK)}' >> ${dir}/${path}.b64`);
    await run(done);
  };
  await put("SKILL.md", await skillMdBytes(sql, files, s));
  for (const f of s.files) {
    const obj = files ? await files.get(skillFileKey(s.id, f.path)) : null;
    if (!obj) throw new Error(`${s.name}'s file ${f.path} isn't in storage.`);
    await put(f.path, new Uint8Array(await obj.arrayBuffer()));
  }
  await flush();
  return dir;
}

/** How much base64 goes in one command when a skill's folder is put in the workspace. */
const UNPACK_CHUNK = 64_000;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8_192) bin += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  return btoa(bin);
}

export const skillRead = defineTool({
  name: "skill_read",
  kind: "look",
  status: "Reading how to do that.",
  description:
    "Open one of your skills by name, before doing a task it covers: the list in your context has each one's name and what it's for. Follow it, and improve it with skill_save if it turns out wrong or incomplete. If it has files (references, scripts), open one with skill_file.",
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
    const src = skillSources(ctx.sql)[s.id];
    return {
      ok: true,
      output: {
        name: s.name,
        description: s.description,
        version: s.version,
        instructions: s.body,
        ...(s.files.length ? { files: s.files.map((f) => f.path) } : {}),
        ...(src ? { from: `${src.hub_name}'s skill hub (${src.repo}), installed by the owner; run its scripts in the workspace` } : {}),
        ...(s.check ? { check: s.check } : {}),
        ...(s.checked && !s.checked.ok ? { broken: `Its last check failed: ${s.checked.output.slice(-500)}` } : {}),
      },
    };
  },
});

export const skillFile = defineTool({
  name: "skill_file",
  kind: "look",
  status: "Reading how to do that.",
  description:
    "Read one file from a skill's folder (a reference, a script, a template), by the path skill_read listed. To run a script, put the folder in the workspace with `unpack` true: it lands at /workspace/skills/<name>.",
  input: z.object({ name: z.string().min(1).max(80), path: z.string().min(1).max(200).optional(), unpack: z.boolean().optional() }),
  async run(input, ctx) {
    const s = findSkill(ctx.sql, input.name);
    if (!s) return fail(`There's no skill called "${input.name}".`);
    if (input.unpack) {
      if (!ctx.workspace) return fail("The workspace can't be used from here.");
      try {
        return { ok: true, output: { folder: await unpackSkill(ctx.workspace, ctx.sql, ctx.files, s, ctx.run_id) } };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    const f = s.files.find((x) => x.path === input.path);
    if (!f)
      return fail(`${s.name} has no file ${input.path ?? "(no path given)"}. It has: ${s.files.map((x) => x.path).join(", ") || "none"}.`);
    const obj = ctx.files ? await ctx.files.get(skillFileKey(s.id, f.path)) : null;
    if (!obj) return fail(`${s.name}'s file ${f.path} isn't in storage.`);
    const text = await obj.text();
    return {
      ok: true,
      output: { name: s.name, path: f.path, content: text.slice(0, 30_000), ...(text.length > 30_000 ? { cut: true } : {}) },
    };
  },
});

export const skillSave = defineTool({
  name: "skill_save",
  kind: "change_own",
  status: "Writing down how.",
  description: [
    "Write down how to do something, as a skill you'll find again next time, or improve one you have.",
    "To improve a skill, use `patch`: each `old` is a passage quoted exactly from the skill, replaced by `new`, so only what was wrong changes. Read the skill first. Fix a misleading line in place rather than adding a note at the end; the same lesson twice is one rule.",
    "A new skill is for a kind of task, named for the kind ('client-invoice'), not for one case. `description` is the line your index shows: what it's for and when to use it. `body` is the steps, in Markdown: what to do, in order, which tools, and what to watch out for. Lessons, not logs: no story of this conversation. Keep the owner's private details out unless the skill needs them.",
    "If a new skill reads like one you have, it's refused with that one's name: improve that one instead, or, if it's truly a different method, save again with `distinct` true and say how it differs in the description.",
    "`files` adds files to its folder (references/, scripts/, templates/, assets/); `check` is an optional shell command that exits 0 while the skill still works (a weekly pass runs it).",
    "Don't save one-off tasks, failures caused by a service being down, or what an existing skill already says.",
  ].join(" "),
  input: z.object({
    name: z.string().min(3).max(64).describe("Short, lowercase words with hyphens: 'file-reimbursements'."),
    description: z.string().min(10).max(300).optional().describe("Needed for a new skill; for an improvement, only when it changes."),
    body: z.string().min(20).max(20_000).optional().describe("The whole skill, for a new one. For an improvement, use `patch`."),
    patch: z
      .array(z.object({ old: z.string().min(1).max(5_000), new: z.string().max(10_000) }))
      .min(1)
      .max(20)
      .optional(),
    files: z
      .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(MAX_FILE) }))
      .max(20)
      .optional(),
    remove_files: z.array(z.string().max(200)).max(20).optional(),
    check: z.string().max(2_000).optional(),
    note: z.string().max(300).optional().describe("For a change: what changed and why."),
    distinct: z.boolean().optional(),
  }),
  async run(input, ctx) {
    try {
      const old = findSkill(ctx.sql, input.name);
      for (const f of input.files ?? [])
        if (!FILE_PATH.test(f.path) || f.path.split("/").includes(".."))
          return fail(
            `"${f.path}" isn't a path in a skill's folder: use references/, scripts/, templates/ or assets/, like scripts/fill.py.`,
          );
      if ((input.files?.length || input.remove_files?.length) && !ctx.files)
        return fail("A skill's files need storage (R2), which this deployment has none of.");
      let body = input.body;
      if (input.patch) {
        if (!old) return fail(`There's no skill called "${input.name}" to patch. Save a new one with body and description.`);
        body = patchBody(old.body, input.patch);
      }
      if (!old && (!body || !input.description))
        return fail("A new skill needs a description (what it's for, when to use it) and a body (the steps).");
      const description = input.description ?? old!.description;
      // One skill per method (§9.3): a new one that reads like one Atlas has is refused with its name.
      let vec: Float32Array | null = null;
      if (!old && ctx.embed) {
        try {
          [vec] = (await ctx.embed.embed([meaningOf({ name: input.name, description })])) as [Float32Array];
        } catch (err) {
          console.error(JSON.stringify({ at: "skills.embed", error: err instanceof Error ? err.message : String(err) }));
        }
        const near = vec ? nearestSkill(ctx.sql, vec, ctx.embed.model) : null;
        if (near && near.score >= SAME_METHOD && !input.distinct)
          return fail(
            `This reads like your skill "${near.skill.name}" (${near.skill.description}). Improve that one instead: skill_save with name "${near.skill.name}" and a patch. If it's truly a different method, save again with distinct true and say how it differs in the description.`,
          );
      }
      const { skill, change } = saveSkill(ctx.sql, {
        name: input.name,
        description,
        body: body ?? old!.body,
        ...(input.check !== undefined ? { check: input.check } : {}),
        by: "atlas",
        run_id: ctx.run_id,
        ...(input.note ? { note: input.note } : {}),
      });
      // The folder's files: written to R2, listed on the skill.
      if (input.files?.length || input.remove_files?.length) {
        const files = new Map<string, SkillFile>(skill.files.map((f) => [f.path, f]));
        for (const p of input.remove_files ?? []) {
          files.delete(p);
          await ctx.files!.delete(skillFileKey(skill.id, p));
        }
        for (const f of input.files ?? []) {
          await ctx.files!.put(skillFileKey(skill.id, f.path), f.content);
          files.set(f.path, { path: f.path, size: new TextEncoder().encode(f.content).length });
        }
        setSkillFiles(ctx.sql, skill.id, [...files.values()]);
      }
      if (change === "same") {
        if (!input.files?.length && !input.remove_files?.length)
          return { ok: true, output: { unchanged: skill.name, note: "That's what the skill already says." } };
        // Only its files changed: no new version, so no Undo that would take back the last one.
        const listed = findSkill(ctx.sql, skill.id)!.files.map((f) => f.path);
        return { ok: true, output: { saved: skill.name, files: listed }, receipt: { text: `Updated a skill's files · ${skill.name}` } };
      }
      if (vec && ctx.embed) setSkillVec(ctx.sql, skill.id, ctx.embed.model, vec);
      else if (!old || input.description) await remember(ctx, skill);
      const checks = skill.check ? ensureSkillChecks(ctx.sql) : null;
      if (checks) await ctx.clock.schedule(checks);
      const made = change === "made";
      return {
        ok: true,
        output: { saved: skill.name, version: skill.version, change: made ? "made" : "patched" },
        receipt: {
          text: made ? `Learned a skill · ${skill.name}` : `Improved a skill · ${skill.name} · version ${skill.version}`,
          undo: { kind: "skill.undo", id: skill.id, version: skill.version },
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

/** The review's way to fold one skill into another (§9.3: duplicates merged). The other is archived, never deleted. */
export const skillMerge = defineTool({
  name: "skill_merge",
  kind: "change_own",
  status: "Merging two skills.",
  description:
    "Fold one skill into another that covers the same method: first improve `into` with skill_save so it says everything `from` taught, then call this to archive `from` (kept, searchable, out of the index).",
  input: z.object({ from: z.string().min(1).max(80), into: z.string().min(1).max(80), note: z.string().max(300).optional() }),
  async run(input, ctx) {
    const from = findSkill(ctx.sql, input.from);
    const into = findSkill(ctx.sql, input.into);
    if (!from || !into) return fail(`There's no skill called "${!from ? input.from : input.into}".`);
    if (from.id === into.id) return fail("A skill can't be merged into itself.");
    setSkillState(ctx.sql, from.id, "archived", "atlas", input.note?.trim() || `Merged into ${into.name}.`);
    return {
      ok: true,
      output: { archived: from.name, kept: into.name },
      receipt: { text: `Merged a skill · ${from.name} into ${into.name}`, undo: { kind: "skill.restore", id: from.id } },
    };
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
      const cwd = s.files.length ? await unpackSkill(ctx.workspace, ctx.sql, ctx.files, s, ctx.run_id) : undefined;
      const r = await ctx.workspace.run(s.check, { run_id: ctx.run_id, timeout_s: 120, ...(cwd ? { cwd } : {}) });
      noteCheck(ctx.sql, s.id, { ok: r.exit === 0, output: r.output });
      return { ok: true, output: { name: s.name, passed: r.exit === 0, exit: r.exit, output: r.output.slice(-3_000) } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const skillFind = defineTool({
  name: "skill_find",
  kind: "look",
  status: "Looking for a skill.",
  timeoutMs: 2 * 60_000,
  description:
    "Search the skill hubs in the catalog (folders of SKILL.md skills that others publish, such as Anthropic's) for a skill to install, when the owner asks you to get one. Search by what it's for, in a word or two ('slides', 'pdf forms', 'spreadsheet'); an empty query lists them all. Each result says what it's for, which hub it's in, and whether it's installed. Install one with skill_install.",
  input: z.object({ query: z.string().max(200) }),
  async run(input, ctx) {
    if (!ctx.hubs) return fail("Skill hubs can only be searched in a conversation with the owner.");
    try {
      const { skills, unread } = await ctx.hubs.find(input.query);
      return {
        ok: true,
        output: {
          skills: skills.map((k) => ({
            hub: k.hub,
            name: k.name,
            for: k.description.slice(0, 400),
            from: k.hub_name,
            ...(k.installed ? { installed: true, ...(k.installed.update ? { update: "the hub has a newer version" } : {}) } : {}),
            ...(k.taken ? { taken: "you have a skill of that name that isn't from this hub" } : {}),
            ...(k.problem ? { cant_install: k.problem } : {}),
          })),
          ...(unread.length ? { unread } : {}),
          ...(skills.length ? {} : { note: "Nothing matched. Try other words for what it's for, or an empty query for every skill." }),
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const skillInstall = defineTool({
  name: "skill_install",
  kind: "change_own",
  status: "Installing that skill.",
  timeoutMs: 3 * 60_000,
  description:
    "Install a skill from a skill hub, by the hub and name skill_find gave, when the owner asked you to get it (or to update one skill_find says has a newer version). It's someone else's instructions, kept with its folder unchanged; its scripts run only in the workspace (skill_file with unpack). The owner sees it with Undo. Then use it with skill_read. Not from a run that has read the web: say so, and that they can install it from Abilities, then Skills, then Get skills.",
  input: z.object({ hub: z.string().min(1).max(40), name: z.string().min(1).max(80) }),
  async run(input, ctx) {
    if (!ctx.hubs) return fail("Skills can only be installed in a conversation with the owner.");
    if (ctx.hubs.readWeb())
      return fail(
        "This run has read the web, which could be steering it, so it doesn't install skills. The owner can ask again in a new message, or install it from Abilities, then Skills, then Get skills.",
      );
    try {
      const r = await ctx.hubs.install(input.hub, input.name, { run_id: ctx.run_id });
      if (r.change === "same") return { ok: true, output: { installed: r.skill.name, note: r.text } };
      const src = skillSources(ctx.sql)[r.skill.id];
      return {
        ok: true,
        output: { installed: r.skill.name, version: r.skill.version, files: r.skill.files.map((f) => f.path), note: r.text },
        receipt: {
          text: `${r.change === "updated" ? "Updated" : "Installed"} a skill · ${r.skill.name}${src ? ` from ${src.hub_name}` : ""}`,
          undo:
            r.change === "updated"
              ? { kind: "skill.undo", id: r.skill.id, version: r.skill.version }
              : { kind: "skill.uninstall", id: r.skill.id },
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const skillTools = [skillRead, skillFile, skillSave, skillCheck];
/** Getting skills from the catalog's skill hubs (§17): only in the owner's own runs. */
export const hubTools = [skillFind, skillInstall];
/** What the review that looks back over a conversation may use (§9.3): skills, and nothing else. */
export const reviewTools = [skillRead, skillFile, skillSave, skillMerge];
