import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams, type WorkspaceStub } from "../src/agent";
import { migrate } from "../src/store/db";
import { ARCHIVE_AFTER_MS, findSkill, listSkills, parseSkillMd, saveSkill, skillMd, tidySkills } from "../src/skills";
import { call, env, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

const CLAUDE_SKILL = `---
name: pdf-forms
description: Fill in PDF forms. Use when the user asks to complete a PDF form.
license: MIT
allowed-tools: Bash, Read
metadata:
  author: someone
---

# Filling PDF forms

1. Read the form's fields with \`python3 fields.py form.pdf\`.
2. Fill them, then check the output opens.
`;

const STEPS = `1. Open the expenses site with browser_open.
2. Sign in with vault_fill (the Expenses login), pressing Sign in.
3. Add each receipt as a line; the date field wants DD/MM/YYYY, not the US order (that failed the first time).
4. Submit with browser_submit and keep the confirmation number.`;

describe("SKILL.md", () => {
  it("reads skills from other agents unchanged, and writes them back out", () => {
    const p = parseSkillMd(CLAUDE_SKILL);
    expect(p).toMatchObject({
      name: "pdf-forms",
      description: "Fill in PDF forms. Use when the user asks to complete a PDF form.",
      check: "",
    });
    expect(p.body.startsWith("# Filling PDF forms")).toBe(true);
    const md = skillMd({ ...p, check: "python3 -c 'import pypdf'" });
    expect(parseSkillMd(md)).toEqual({ ...p, check: "python3 -c 'import pypdf'" });
    expect(() => parseSkillMd("no frontmatter here")).toThrow("starts with frontmatter");
  });

  it("archives skills nobody used for months, and never deletes them", async () => {
    await runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName("skills-tidy")), async (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      saveSkill(sql, {
        name: "Old Thing",
        description: "Something done long ago, once.",
        body: "1. Do the old thing, step by step.",
        by: "atlas",
      });
      saveSkill(sql, {
        name: "fresh-thing",
        description: "Something used this week.",
        body: "1. Do the fresh thing, step by step.",
        by: "atlas",
      });
      expect(tidySkills(sql, Date.now() + ARCHIVE_AFTER_MS / 2)).toEqual([]);
      sql.exec(`UPDATE skills SET last_used = ? WHERE name = 'fresh-thing'`, Date.now() + ARCHIVE_AFTER_MS);
      expect(tidySkills(sql, Date.now() + ARCHIVE_AFTER_MS + 1_000)).toEqual(["old-thing"]);
      expect(listSkills(sql).map((s) => s.name)).toEqual(["fresh-thing"]);
      expect(findSkill(sql, "old-thing")).toMatchObject({ state: "archived" });
    });
  });
});

let checks: Array<{ command: string }> = [];
let checkExit = 0;

beforeEach(async () => {
  checks = [];
  checkExit = 0;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  const ws: WorkspaceStub = {
    async run(o) {
      checks.push({ command: o.command });
      const enc = new TextEncoder();
      const lines = [
        { out: checkExit ? "ModuleNotFoundError: No module named 'pypdf'\n" : "ok\n" },
        { done: { exit: checkExit, ms: 10, blocked: [], kept: "" } },
      ];
      return new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
          c.close();
        },
      });
    },
    async read() {
      return { ok: false, error: "no" };
    },
    async list() {
      return null;
    },
    async preview() {
      return { token: "x", expires: 0 };
    },
    async restart() {},
    async status() {
      return { running: false, ready: true };
    },
  };
  seams.workspace = ws;
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM skills`);
    sql.exec(`DELETE FROM skill_versions`);
    sql.exec(`DELETE FROM agenda WHERE kind = 'skills'`);
  });
});
afterEach(() => {
  seams.workspace = undefined;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("skills in a run", () => {
  it("learns a skill with a receipt and Undo, finds it again in the index, uses it, and patches it", async () => {
    const s = await connect();
    brain([
      call("skill_save", {
        name: "File Reimbursements",
        description: "File work expense reimbursements on the expenses site. Use when the owner asks to claim expenses.",
        body: STEPS,
      }),
      say("I'll remember how."),
    ]);
    const learned = await turn(s, "thanks, that worked");
    const receipt = learned.results[0]!.body.receipt as { text: string; undo: { kind: string; id: string; version: number } };
    expect(receipt).toMatchObject({ text: "Learned a skill · file-reimbursements", undo: { kind: "skill.undo", version: 1 } });

    // The next run sees it in the index, opens it, and the use is counted.
    const b = brain([call("skill_read", { name: "file-reimbursements" }), say("Following my notes.")]);
    const used = await turn(s, "file my expenses from this week");
    expect(b.requests[0]!.system).toContain(
      "- file-reimbursements: File work expense reimbursements on the expenses site. Use when the owner asks to claim expenses.",
    );
    expect(out(used.results[0]!)).toContain("DD/MM/YYYY");
    expect(await inOwner((_a, sql) => findSkill(sql, "file-reimbursements")!.uses)).toBe(1);

    // Improved: a new version that says what changed.
    brain([
      call("skill_save", {
        name: "file-reimbursements",
        description: "File work expense reimbursements on the expenses site. Use when the owner asks to claim expenses.",
        body: `${STEPS}\n5. Attach the PDF of each receipt.`,
        note: "Receipts need their PDF attached now.",
      }),
      say("Updated."),
    ]);
    const patched = await turn(s, "they want the PDFs too now");
    expect(patched.results[0]!.body.receipt).toMatchObject({ text: "Improved a skill · file-reimbursements · version 2" });

    // Undo on that receipt goes back a version, as a new version.
    s.send({ type: "atlas.skills" });
    const listed = (await s.next("atlas.skills")).skills;
    expect(listed[0]).toMatchObject({
      name: "file-reimbursements",
      version: 2,
      versions: [{ n: 2, note: "Receipts need their PDF attached now." }, { n: 1 }],
    });
    s.send({
      type: "atlas.undo",
      log_id: await inOwner(
        (_a, sql) =>
          sql
            .exec<{ id: string }>(
              `SELECT id FROM log WHERE kind = 'tool.result' AND json_extract(body, '$.call_id') = 'call_skill_save' ORDER BY seq DESC LIMIT 1`,
            )
            .one().id,
      ),
    });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "skill.change" && String(r.body.note).startsWith("Undid version 2")));
    expect(await inOwner((_a, sql) => findSkill(sql, "file-reimbursements")!)).toMatchObject({ version: 3, body: STEPS });
  });

  it("imports a SKILL.md from the Skills page, runs its check weekly, and says once when it breaks", async () => {
    const s = await connect();
    s.send({ type: "atlas.skill.save", md: skillMd({ ...parseSkillMd(CLAUDE_SKILL), check: "python3 -c 'import pypdf'" }) });
    const skills = (await s.next("atlas.skills", (m) => m.skills.length > 0)).skills;
    expect(skills[0]).toMatchObject({ name: "pdf-forms", made_by: "owner", check: "python3 -c 'import pypdf'" });
    const item = await inOwner((_a, sql) =>
      sql.exec<{ id: string; due_at: number }>(`SELECT id, due_at FROM agenda WHERE kind = 'skills' AND state = 'scheduled'`).one(),
    );
    expect(item.due_at).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // The pass: the check fails, the skill is flagged, and the owner hears once.
    checkExit = 1;
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1, item.id);
      await agent.onAgendaDue({ id: item.id });
    });
    expect(checks).toEqual([{ command: "python3 -c 'import pypdf'" }]);
    const after = await inOwner((_a, sql) => ({
      skill: findSkill(sql, "pdf-forms")!,
      said: sql.exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'message.out' ORDER BY seq DESC LIMIT 1`).one().body,
      next: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agenda WHERE kind = 'skills' AND state = 'scheduled'`).one().n,
    }));
    expect(after.skill.checked).toMatchObject({ ok: false, output: expect.stringContaining("No module named 'pypdf'") });
    expect(JSON.parse(after.said).text).toContain("pdf-forms: ModuleNotFoundError");
    expect(after.next).toBe(1);

    // The index flags it for Atlas.
    const b = brain([say("Noted.")]);
    await turn(s, "anything broken?");
    expect(b.requests[0]!.system).toContain(
      "- pdf-forms: Fill in PDF forms. Use when the user asks to complete a PDF form. (its last check failed)",
    );
  });
});

describe("skills learned better (M7)", () => {
  beforeEach(async () => {
    await inOwner((_a, sql) => {
      sql.exec(`DELETE FROM agenda WHERE kind = 'skill_review'`);
      sql.exec(`DELETE FROM state WHERE key IN ('skill_review_seq', 'skill_pairs_offered')`);
    });
  });

  it("patches only the passage that was wrong, refuses a near-duplicate, and keeps a folder of files", async () => {
    const s = await connect();
    const desc = "File work expense reimbursements on the expenses site. Use when the owner asks to claim expenses.";
    brain([call("skill_save", { name: "file-reimbursements", description: desc, body: STEPS }), say("Kept.")]);
    await turn(s, "thanks, that worked");

    // A second skill for the same method is refused, with the one to improve instead.
    brain([
      call("skill_save", { name: "claim-expenses", description: `Claim expenses: ${desc}`, body: STEPS }),
      say("I'll improve the one I have."),
    ]);
    const dup = await turn(s, "remember how to claim expenses");
    expect(out(dup.results[0]!)).toMatch(/This reads like your skill .{0,2}file-reimbursements/);
    expect(await inOwner((_a, sql) => findSkill(sql, "claim-expenses"))).toBeNull();

    // A patch replaces only the passage that was wrong; a passage it doesn't have is refused plainly.
    brain([
      call("skill_save", {
        name: "file-reimbursements",
        patch: [{ old: "the date field wants DD/MM/YYYY", new: "the date field wants YYYY-MM-DD since the redesign" }],
        note: "The site's date format changed.",
      }),
      call("skill_save", { name: "file-reimbursements", patch: [{ old: "a passage it never had", new: "x" }] }, "call_bad_patch"),
      say("Fixed."),
    ]);
    const patched = await turn(s, "the dates are the other way round now");
    expect(patched.results[0]!.body.receipt).toMatchObject({ text: "Improved a skill · file-reimbursements · version 2" });
    expect(out(patched.results[1]!)).toContain("doesn't say");
    const skill = await inOwner((_a, sql) => findSkill(sql, "file-reimbursements")!);
    expect(skill.body).toBe(STEPS.replace("the date field wants DD/MM/YYYY", "the date field wants YYYY-MM-DD since the redesign"));
    expect(skill.description).toBe(desc);

    // Its folder: a script, listed by skill_read, read by skill_file; a path outside the folder is refused.
    brain([
      call("skill_save", {
        name: "file-reimbursements",
        files: [{ path: "scripts/receipts.py", content: "print('receipts')" }],
      }),
      call("skill_save", { name: "file-reimbursements", files: [{ path: "../secrets.txt", content: "x" }] }, "call_bad_path"),
      call("skill_read", { name: "file-reimbursements" }),
      call("skill_file", { name: "file-reimbursements", path: "scripts/receipts.py" }),
      say("Saved the script with it."),
    ]);
    const files = await turn(s, "keep the receipts script with it");
    expect(out(files.results[1]!)).toContain("isn't a path in a skill's folder");
    expect(out(files.results[2]!)).toContain("scripts/receipts.py");
    expect(out(files.results[3]!)).toContain("print('receipts')");
    expect(files.results[0]!.body.receipt).toMatchObject({ text: "Updated a skill's files · file-reimbursements" });
    expect(files.results[0]!.body.receipt).not.toHaveProperty("undo");

    // Its check runs in its folder, put in the workspace first.
    checks = [];
    brain([
      call("skill_save", { name: "file-reimbursements", check: "python3 scripts/receipts.py" }),
      call("skill_check", { name: "file-reimbursements" }),
      say("It still works."),
    ]);
    await turn(s, "check the reimbursements skill still works");
    const commands = checks.map((c) => c.command);
    expect(commands.some((c) => c.includes("base64 -d /workspace/skills/file-reimbursements/scripts/receipts.py.b64"))).toBe(true);
    expect(commands.at(-1)).toBe("python3 scripts/receipts.py");
  });

  it("looks back over a conversation once it goes quiet, with only the skill tools, and skips talk that took no working out", async () => {
    const s = await connect();
    const recall = (n: number) => call("recall", { query: `expenses ${n}` }, `call_recall_${n}`);
    brain([recall(1), recall(2), recall(3), recall(4), say("Done: filed, with the dates the right way round.")]);
    await turn(s, "file this week's expenses, and the dates go year first now");
    const item = await inOwner((_a, sql) =>
      sql.exec<{ id: string; due_at: number }>(`SELECT id, due_at FROM agenda WHERE kind = 'skill_review' AND state = 'scheduled'`).one(),
    );
    expect(item.due_at).toBeGreaterThan(Date.now() + 9 * 60_000);

    // Once quiet, the review runs as Atlas's own run, sees the conversation, and keeps a skill.
    const b = brain([
      call("skill_save", {
        name: "file-reimbursements",
        description: "File work expense reimbursements on the expenses site. Use when the owner asks to claim expenses.",
        body: STEPS,
      }),
      say("Kept: file-reimbursements, with the date format the owner gave."),
    ]);
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1, item.id);
      await agent.onAgendaDue({ id: item.id });
    });
    expect(b.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["skill_file", "skill_merge", "skill_read", "skill_save"]);
    expect(JSON.stringify(b.requests[0]!.messages)).toContain("the dates go year first now");
    expect(JSON.stringify(b.requests[0]!.messages)).toContain("Look back over your conversation with the owner");
    const after = await inOwner((_a, sql) => ({
      skill: findSkill(sql, "file-reimbursements"),
      run: sql.exec<{ actor: string; state: string }>(`SELECT actor, state FROM runs WHERE trigger = 'skill_review'`).one(),
      item: sql.exec<{ state: string }>(`SELECT state FROM agenda WHERE id = ?`, item.id).one().state,
    }));
    expect(after.skill).toMatchObject({ made_by: "atlas", version: 1 });
    expect(after.run).toEqual({ actor: "atlas", state: "replied" });
    expect(after.item).toBe("done");

    // A stretch of talk with no working out is skipped without a run.
    brain([say("Sure.")]);
    await turn(s, "thanks");
    const quiet = await inOwner((_a, sql) =>
      sql.exec<{ id: string }>(`SELECT id FROM agenda WHERE kind = 'skill_review' AND state = 'scheduled'`).one(),
    );
    brain([]); // the script is empty: a run would fail the test
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1, quiet.id);
      await agent.onAgendaDue({ id: quiet.id });
    });
    expect(
      await inOwner((_a, sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE trigger = 'skill_review'`).one().n),
    ).toBe(1);
  });

  it("asks the review to merge two skills that read like the same method, once", async () => {
    await inOwner((_a, sql) => {
      saveSkill(sql, {
        name: "rent-camera-gear",
        description: "Rent camera lenses for a shoot from the rental shops, comparing price and pickup.",
        body: "1. Ask each rental shop for a quote.",
        by: "atlas",
      });
      saveSkill(sql, {
        name: "hire-lenses",
        description: "Hire camera lenses for a shoot from the rental shops, comparing price and pickup.",
        body: "1. Ask each shop for a quote and the pickup time.",
        by: "atlas",
      });
    });
    await inOwner((agent) => agent.apiSettleMemory());
    const merge = await inOwner((_a, sql) =>
      sql
        .exec<{ id: string; source: string }>(`SELECT id, source FROM agenda WHERE kind = 'skill_review' AND state = 'scheduled'`)
        .toArray(),
    );
    expect(merge).toHaveLength(1);
    expect(JSON.parse(merge[0]!.source).detail.merge).toEqual([["hire-lenses", "rent-camera-gear"]]);

    const b = brain([
      call("skill_save", {
        name: "rent-camera-gear",
        patch: [{ old: "Ask each rental shop for a quote.", new: "Ask each rental shop for a quote and the pickup time." }],
      }),
      call("skill_merge", { from: "hire-lenses", into: "rent-camera-gear" }),
      say("Merged hire-lenses into rent-camera-gear."),
    ]);
    await inOwner(async (agent, sql) => {
      sql.exec(`UPDATE agenda SET due_at = ? WHERE id = ?`, Date.now() - 1, merge[0]!.id);
      await agent.onAgendaDue({ id: merge[0]!.id });
    });
    expect(JSON.stringify(b.requests[0]!.messages)).toContain("hire-lenses and rent-camera-gear");
    expect(await inOwner((_a, sql) => findSkill(sql, "hire-lenses")!.state)).toBe("archived");

    // The same pair isn't offered again.
    await inOwner((agent) => agent.apiSettleMemory());
    expect(
      await inOwner(
        (_a, sql) =>
          sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agenda WHERE kind = 'skill_review' AND state = 'scheduled'`).one().n,
      ),
    ).toBe(0);
  });
});
