// Atlas's hands on automations (§13.4): making one from what the owner says
// (it starts paused), a test run that sends nothing, running one now, and
// turning one on or pausing it. Turning on what Atlas made needs a test run
// first, so the owner sees what it would do before it runs on its own.

import { z } from "zod";
import {
  AutomationInput,
  findAutomation,
  getAutomation,
  listAutomations,
  saveAutomation,
  setAutomationState,
  stepText,
  whenText,
} from "../automations";
import { findWebhook, webhooks } from "../webhooks";
import { defineTool, fail } from "./types";

const names = (sql: Parameters<typeof getAutomation>[0]) => (id: string) => getAutomation(sql, id)?.name ?? null;

export const automationSave = defineTool({
  name: "automation_save",
  kind: "change_own",
  description: [
    "Make an automation, or change one (pass its id): when it runs, what it does, and where it reports.",
    "Use it when the owner asks for something to happen on its own or on request: 'every weekday at 8, give me a short brief', 'when I say goodnight, turn off the lights', 'tell me if I haven't logged a workout in 3 days', 'watch this page for a price drop'.",
    "`when`: request (a phrase, with $inputs, or just the Run button), schedule (a local time and days, 0 for Sunday to 6 for Saturday; empty for every day), watch (a page, how often, and what change matters), absence (words that would show something happened, how many days without them, and when to check), or event (after another automation's id).",
    "`do` is a list of steps: say (fixed words, sent as written), webhook (one of the owner's webhooks by name), or atlas (your own note for that moment, for anything that needs looking up or judgment). Use fixed steps when nothing needs judgment: they run fast, with no model.",
    "What you make starts paused, and a change you make pauses it, until the owner has seen a test run: offer to run one with automation_test.",
  ].join(" "),
  input: AutomationInput.extend({ id: z.string().max(64).optional().describe("The automation to change.") }),
  async run(input, ctx) {
    if (!ctx.automations) return fail("Automations can't be changed from here.");
    for (const s of input.do) {
      if (s.kind === "webhook" && !findWebhook(ctx.sql, s.webhook)) {
        const have = webhooks(ctx.sql).map((w) => w.name);
        return fail(
          `There's no webhook called "${s.webhook}". ${have.length ? `The owner's webhooks are: ${have.join(", ")}.` : "The owner has none yet; they add them in Settings → Connections."}`,
        );
      }
    }
    if (input.when.kind === "event" && !getAutomation(ctx.sql, input.when.after))
      return fail(`There's no automation with id ${input.when.after} to run after.`);
    const { id, ...rest } = input;
    let saved;
    try {
      saved = saveAutomation(ctx.sql, rest, "atlas", id);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    await ctx.automations.arm(saved.id);
    return {
      ok: true,
      output: {
        id: saved.id,
        name: saved.name,
        when: whenText(saved.when, names(ctx.sql)),
        do: saved.do.map(stepText),
        state: "paused until the owner has seen a test run",
      },
      receipt: {
        text: `${id ? "Changed" : "Made"} automation · ${saved.name} · paused until you've seen a test run`,
        view: { kind: "automation", automation: saved.id },
      },
    };
  },
});

export const automationTest = defineTool({
  name: "automation_test",
  kind: "look",
  status: "Trying it out.",
  timeoutMs: 180_000,
  description:
    "Test run an automation: it uses real data and sends nothing, then shows what it would have done. Run one after making or changing an automation, so the owner can turn it on.",
  input: z.object({ automation: z.string().min(1).max(80).describe("The automation's name or id.") }),
  async run(input, ctx) {
    if (!ctx.automations) return fail("Automations can't be tested from here.");
    const a = findAutomation(ctx.sql, input.automation);
    if (!a) return fail(`There's no automation called "${input.automation}".`);
    const out = await ctx.automations.run(a, { why: "test" });
    return {
      ok: true,
      output: { ok: out.ok, would_send: out.text, steps: out.results, ...(out.error ? { error: out.error } : {}) },
      receipt: {
        text: `Test run · ${a.name} · ${out.ok ? "sent nothing" : "didn't work"}`,
        view: { kind: "automation", automation: a.id },
      },
    };
  },
});

export const automationRun = defineTool({
  name: "automation_run",
  kind: "change_own",
  status: "Running it.",
  timeoutMs: 180_000,
  description:
    "Run one of the owner's automations now, when they ask for it ('run my morning brief', 'focus for 45 minutes' when that's an automation's phrase), with any $inputs it takes. It reports where it always does, so don't repeat what it said.",
  input: z.object({
    automation: z.string().min(1).max(80).describe("The automation's name or id."),
    inputs: z.record(z.string().max(30), z.string().max(200)).optional().describe("Values for its $inputs, by name without the $."),
  }),
  async run(input, ctx) {
    if (!ctx.automations) return fail("Automations can't be run from here.");
    const a = findAutomation(ctx.sql, input.automation);
    if (!a) return fail(`There's no automation called "${input.automation}".`);
    const out = await ctx.automations.run(a, { why: "request", inputs: input.inputs });
    return out.ok
      ? {
          ok: true,
          output: { ran: a.name, it_said: out.text },
          receipt: { text: `Ran · ${a.name}`, view: { kind: "automation", automation: a.id } },
        }
      : fail(`${a.name} didn't run: ${out.error}`);
  },
});

export const automationSet = defineTool({
  name: "automation_set",
  kind: "change_own",
  description:
    "Turn an automation on, or pause it, when the owner asks. One you made or changed needs a test run first; if it hasn't had one, run automation_test and show the owner what it would do.",
  input: z.object({ automation: z.string().min(1).max(80).describe("The automation's name or id."), on: z.boolean() }),
  async run(input, ctx) {
    if (!ctx.automations) return fail("Automations can't be changed from here.");
    const a = findAutomation(ctx.sql, input.automation);
    if (!a) return fail(`There's no automation called "${input.automation}".`);
    try {
      setAutomationState(ctx.sql, a.id, input.on, "atlas");
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    await ctx.automations.arm(a.id);
    return {
      ok: true,
      output: { name: a.name, state: input.on ? "on" : "paused" },
      receipt: { text: `${input.on ? "Turned on" : "Paused"} · ${a.name}`, view: { kind: "automation", automation: a.id } },
    };
  },
});

export const automationList = defineTool({
  name: "automation_list",
  kind: "look",
  description: "List the owner's automations: each one's id, name, when it runs, what it does, and whether it's on.",
  input: z.object({}),
  async run(_input, ctx) {
    return {
      ok: true,
      output: {
        automations: listAutomations(ctx.sql).map((a) => ({
          id: a.id,
          name: a.name,
          state: a.state,
          when: whenText(a.when, names(ctx.sql)),
          do: a.do.map(stepText),
          report: a.report,
          ...(a.made_by === "atlas" && !a.tested_at ? { needs: "a test run before it can be turned on" } : {}),
        })),
      },
    };
  },
});

export const automationTools = [automationSave, automationTest, automationRun, automationSet, automationList];
