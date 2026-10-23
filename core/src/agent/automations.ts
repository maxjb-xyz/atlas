// Running automations (§13). Fixed steps run as written with no model; an
// Atlas step is a run of Atlas's own with its note. A test run uses real
// data and sends nothing. Every run leaves an `automation.run` row with each
// step's result, how long it took and what it cost; two failures in a row
// tell the owner, and five pause it. Watches look first and ask `decide`
// whether a change matters before Atlas wakes (§10.3, §13.2).

import {
  type Automation,
  fill,
  getAutomation,
  listAutomations,
  nextRun,
  noteRun,
  onClock,
  setAutomationState,
  setMemo,
  stepText,
} from "../automations";
import type { Decider } from "../brains/decide";
import type { Calendar, CalendarEvent } from "../calendar/types";
import type { LoopResult } from "../loop";
import type { Outbox, Urgency } from "../outbox";
import { type AgendaItem, createItem, finish, getItem, rearm } from "../store/agenda";
import { type Json, parse, type Sql } from "../store/db";
import { describe } from "../intake";
import { append, type LogRow } from "../store/log";
import { keywordSearch } from "../store/memory";
import { endRun, startRun } from "../store/runs";
import { readSettings } from "../store/settings";
import { shortLocal, zoneOf } from "../time";
import type { ToolContext } from "../tools/types";
import { findWebhook } from "../webhooks";
import { pageText } from "../web";

export type Why = "button" | "request" | "schedule" | "watch" | "absence" | "event" | "calendar" | "test";

export interface RunOutcome {
  ok: boolean;
  /** What it says to the owner: its fixed words and Atlas's, together. */
  text: string;
  error?: string;
  results: Array<{ step: string; ok: boolean; text: string }>;
  steps: number;
  brain: { provider: string; model: string } | null;
  usage: { input: number; output: number };
  run_id: string;
}

export interface DeskDeps {
  sql: Sql;
  outbox: Outbox;
  clock: ToolContext["clock"];
  /** Runs Atlas with a note (an Atlas step); `test` gives it tools that can't change or send anything. */
  /** A run of Atlas for an Atlas step. With `worth`, it speaks only with `nudge`, and may end in silence. */
  converse(o: {
    runId: string;
    note: string;
    test: boolean;
    worth?: { id: string; name: string };
  }): Promise<LoopResult & { nudged?: string | null }>;
  /** The day as a look sees it: the later pile, what was said today, the owner's lists; `seen` marks the pile looked at. */
  picture(): { text: string; seen: () => void };
  decider(): Decider | null;
  /** The owner's calendar, or null when it isn't connected. */
  calendar(): Calendar | null;
  fetch: typeof fetch;
  /** Tells every app the automations changed. */
  changed(): void;
  rows(rows: LogRow[]): void;
}

/** What the exit check needs to know about a run that belongs to an automation. */
export interface AutomationRun {
  test: boolean;
  /** Webhooks this run may call without asking (lowercase names). */
  allowed: string[];
}

export class AutomationDesk {
  /** Runs in progress that belong to automations, for the exit check. */
  readonly runs = new Map<string, AutomationRun>();

  constructor(private readonly d: DeskDeps) {}

  /**
   * Runs an automation. With `runId`, the caller owns the run (a phrase the
   * owner said): it saves the run's end and delivers the text. Otherwise this
   * starts the run, ends it, and reports where the automation says.
   */
  async run(
    a: Automation,
    o: { why: Why; inputs?: Record<string, string>; context?: string; runId?: string; depth?: number },
  ): Promise<RunOutcome> {
    const test = o.why === "test";
    const own = !o.runId;
    const runId =
      o.runId ??
      startRun(this.d.sql, {
        actor: "atlas",
        trigger: `${test ? "automation-test" : "automation"}:${a.id}`,
        surface: "none",
        role: "main",
      });
    const started = Date.now();
    const inputs = o.inputs ?? {};
    let context = o.context;
    // A test of a trigger that looks first (a watch, an absence, the calendar) looks the way the clock would, remembering nothing.
    if (test && !context && looksFirst(a)) {
      try {
        context = `What the look found (in a real run, the steps only run when it says so): ${(await this.look(a, true)).note}`;
      } catch (err) {
        context = `The look failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const fixed = a.do.filter((s) => s.kind === "webhook").map((s) => (s as { webhook: string }).webhook.toLowerCase());
    this.runs.set(runId, { test, allowed: [...new Set([...a.allowed, ...fixed])] });
    const results: RunOutcome["results"] = [];
    const said: string[] = [];
    /** What Atlas steps said as nudges, when the automation reports when it's worth saying. */
    const spoke: string[] = [];
    let brain: RunOutcome["brain"] = null;
    const usage = { input: 0, output: 0 };
    let steps = 0;
    let error: string | undefined;
    try {
      for (const step of a.do) {
        if (step.kind === "say") {
          const text = fill(step.text, inputs);
          said.push(text);
          results.push({ step: stepText(step), ok: true, text });
        } else if (step.kind === "webhook") {
          const hook = findWebhook(this.d.sql, step.webhook);
          const message = step.message ? fill(step.message, inputs) : undefined;
          if (!hook) {
            error = `There's no webhook called ${step.webhook} any more.`;
            results.push({ step: stepText(step), ok: false, text: error });
            break;
          }
          if (test) {
            results.push({ step: stepText(step), ok: true, text: `Would call ${hook.name}${message ? ` with "${message}"` : ""}.` });
            continue;
          }
          const out = await this.d.outbox.perform(
            { kind: "webhook", webhook: hook.id, name: hook.name, ...(message ? { message } : {}) },
            { run_id: runId, by: "automation" },
          );
          results.push({ step: stepText(step), ok: out.ok, text: out.text });
          if (!out.ok) {
            error = out.text;
            break;
          }
        } else {
          const picture = this.d.picture();
          const worth = a.report === "worth";
          const note = this.#note(a, o.why, step.instructions, inputs, results, context, test, picture.text, worth);
          const res = await this.d.converse({ runId, note, test, ...(worth && !test ? { worth: { id: a.id, name: a.name } } : {}) });
          steps += res.steps;
          brain = res.brain ?? brain;
          usage.input += res.usage.input;
          usage.output += res.usage.output;
          // Reporting when it's worth saying, a step that says nothing has done its job: silence is an answer.
          if (res.state !== "replied" || (!res.text.trim() && !(worth && !test))) {
            error = res.error ?? "Atlas gave no answer.";
            results.push({ step: stepText(step), ok: false, text: error });
            break;
          }
          // Only a look that reports to the owner has looked the pile over for them; a watch that reports to History hasn't.
          if (!test && (a.report === "thread" || worth)) picture.seen();
          if (worth && !test) {
            // What it said went out as a nudge already; its last words are its note for History.
            if (res.nudged) spoke.push(res.nudged);
            results.push({
              step: stepText(step),
              ok: true,
              text: res.nudged ?? `Nothing worth saying${res.text.trim() ? `: ${res.text.trim()}` : "."}`,
            });
          } else {
            said.push(res.text.trim());
            results.push({ step: stepText(step), ok: true, text: res.text.trim() });
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.runs.delete(runId);
    }
    const ok = !error;
    const text =
      [...spoke, ...said].join("\n\n") || (ok ? (a.report === "worth" ? `Nothing worth saying: ${a.name}.` : `Done: ${a.name}.`) : "");
    const row = append(this.d.sql, {
      actor: "atlas",
      kind: "automation.run",
      run_id: runId,
      body: {
        automation_id: a.id,
        name: a.name,
        why: o.why,
        test,
        ok,
        report: a.report,
        results: results as unknown as Json,
        text: text.slice(0, 4_000),
        ...(error ? { error } : {}),
        ms: Date.now() - started,
        brain: brain ? `${brain.provider}:${brain.model}` : null,
        usage,
      },
    });
    this.d.rows([row]);
    if (own) {
      endRun(this.d.sql, runId, ok ? "replied" : "failed", steps, { ...(error ? { error } : {}), automation: a.id });
      // What a step said as a nudge went out already; what's left (a say step's words) is reported as usual.
      if (!test)
        await this.#report(
          a,
          ok ? said.join("\n\n") || (spoke.length || a.report === "worth" ? "" : text) : `${a.name} didn't run: ${error}`,
          runId,
          o.why,
        );
    }
    const fails = noteRun(this.d.sql, a.id, { test, ok });
    if (!test && !ok) await this.#failed(a, fails, error!);
    this.d.changed();
    const outcome: RunOutcome = { ok, text, ...(error ? { error } : {}), results, steps, brain, usage, run_id: runId };
    // Another automation waiting for this one runs next (§13.2: another automation finishing).
    if (!test && ok && (o.depth ?? 0) < 3) {
      for (const next of listAutomations(this.d.sql)) {
        if (next.state === "on" && next.when.kind === "event" && next.when.on === "automation" && next.when.after === a.id) {
          await this.run(next, {
            why: "event",
            context: `"${a.name}" just finished. What it said: ${text.slice(0, 1_500)}`,
            depth: (o.depth ?? 0) + 1,
          });
        }
      }
    }
    return outcome;
  }

  #note(
    a: Automation,
    why: Why,
    instructions: string,
    inputs: Record<string, string>,
    done: RunOutcome["results"],
    context: string | undefined,
    test: boolean,
    picture: string,
    worth: boolean,
  ): string {
    return [
      `[Atlas's automation "${a.name}", not the owner] It's running now (${WHY[why]}).`,
      context ?? "",
      Object.keys(inputs).length
        ? `Inputs: ${Object.entries(inputs)
            .map(([k, v]) => `${k} = ${v}`)
            .join(", ")}`
        : "",
      done.length ? `Steps already done:\n${done.map((r) => `- ${r.step}: ${r.text}`).join("\n")}` : "",
      picture,
      `Your instructions: ${fill(instructions, inputs)}`,
      test
        ? `This is a test run: it uses real data and sends nothing. Your tools can look but not change anything, and webhooks only say what they would do. Write exactly what you would send the owner${worth ? ", or that you'd stay quiet and why" : ""}.`
        : worth
          ? "Do it now with your tools, looking things up rather than assuming. If there's something worth telling the owner, nudge once with it, short, as you'd say it; if there isn't, don't nudge, and end with a few words for your own log saying why. Silence is a fine outcome."
          : "Do it now with your tools, looking things up rather than assuming. Then write what to tell the owner: short, as you'd say it.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Sends the result where the automation reports. Inbox reads the run's row; silent ones stay in History. */
  async #report(a: Automation, text: string, runId: string, why: Why): Promise<void> {
    if (a.report !== "thread" || !text) return;
    // A time or a request the owner chose doesn't wait for quiet hours; a watch or an absence can.
    const urgency: Urgency = why === "schedule" || why === "request" || why === "button" ? "now" : "normal";
    await this.d.outbox.deliver(
      { text, run_id: runId, channel: "app", trigger: `automation:${a.id}`, urgency },
      { alreadyStreamed: false },
    );
  }

  /** Two failures in a row tell the owner; five pause the automation and say why (§13.4). */
  async #failed(a: Automation, fails: number, error: string): Promise<void> {
    let text: string | null = null;
    if (fails >= PAUSE_AFTER) {
      setAutomationState(this.d.sql, a.id, false, "atlas", `It failed ${fails} times in a row. The last time: ${error}`);
      await this.disarm(a.id);
      text = `I paused ${a.name}: it failed ${fails} times in a row. The last time: ${error} Turn it back on from Automations once that's fixed.`;
    } else if (fails === TELL_AFTER) {
      text = `${a.name} failed twice in a row. The last time: ${error} I'll keep trying; after ${PAUSE_AFTER} in a row I'll pause it.`;
    }
    if (text)
      await this.d.outbox.deliver(
        { text, run_id: null, channel: "app", trigger: `automation:${a.id}`, urgency: "normal" },
        { alreadyStreamed: false },
      );
  }

  // --- the clock ------------------------------------------------------------------------

  /** Puts an automation's next run on the clock, or takes it off when it's paused or doesn't run on a clock. */
  async arm(id: string): Promise<void> {
    const a = getAutomation(this.d.sql, id);
    const item = this.#item(id);
    if (!a || a.state !== "on" || !onClock(a.when)) {
      if (item) await this.disarm(id);
      return;
    }
    const tz = zoneOf(readSettings(this.d.sql));
    const next = nextRun(a.when, new Date(), tz);
    if (!next) return;
    if (item) {
      if (item.schedule_id) await this.d.clock.unschedule(item);
      const re = rearm(this.d.sql, item.id, next.getTime());
      if (re) await this.d.clock.schedule(re);
      return;
    }
    const made = createItem(this.d.sql, {
      kind: "automation",
      title: a.name,
      due_at: next.getTime(),
      source: { via: "automation", detail: { automation: a.id } },
    });
    await this.d.clock.schedule(made);
  }

  async disarm(id: string): Promise<void> {
    const item = this.#item(id);
    if (!item) return;
    await this.d.clock.unschedule(item);
    finish(this.d.sql, item.id, "cancelled", null, { by: "atlas" });
  }

  #item(id: string): AgendaItem | null {
    const r = this.d.sql
      .exec<{ id: string }>(
        `SELECT id FROM agenda WHERE kind = 'automation' AND state IN ('scheduled', 'running') AND json_extract(source, '$.detail.automation') = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
    return r ? getItem(this.d.sql, r.id) : null;
  }

  /** The clock woke an automation (its item is leased): look first if it's a watch or an absence, run, then set the next time. */
  async due(item: AgendaItem): Promise<void> {
    const id = String(item.source.detail?.automation ?? "");
    const a = getAutomation(this.d.sql, id);
    if (!a || a.state !== "on" || !onClock(a.when)) {
      finish(this.d.sql, item.id, "cancelled", null, { by: "atlas" });
      return;
    }
    try {
      if (a.when.kind === "schedule") await this.run(a, { why: "schedule" });
      else {
        const look = await this.look(a, false);
        if (look.run) await this.run(a, { why: a.when.kind, context: look.note });
      }
    } finally {
      // The next time is set even if this one failed, so a bad night doesn't stop tomorrow's.
      const tz = zoneOf(readSettings(this.d.sql));
      const next = nextRun(a.when, new Date(), tz);
      if (next && getAutomation(this.d.sql, id)?.state === "on") {
        const re = rearm(this.d.sql, item.id, next.getTime());
        if (re) await this.d.clock.schedule(re);
      } else finish(this.d.sql, item.id, "done", null);
    }
  }

  /**
   * The cheap look before a watch or an absence wakes Atlas. A watch fetches
   * the page and, if it changed, asks `decide` whether the change is the kind
   * that matters; an absence searches what was said since. Quiet looks leave
   * a row in History too. In a test, nothing is remembered.
   */
  async look(a: Automation, test: boolean): Promise<{ run: boolean; note: string }> {
    const t = a.when;
    if (t.kind === "absence") {
      const since = Date.now() - t.for_days * 86_400_000;
      const found = keywordSearch(this.d.sql, t.nothing_about, { from: since }, 3);
      const last = typeof a.memo.fired_at === "number" ? a.memo.fired_at : 0;
      const tz = zoneOf(readSettings(this.d.sql));
      if (found.length)
        return this.#quiet(a, test, `Found something about "${t.nothing_about}" since ${shortLocal(new Date(since), tz)}, so it's quiet.`);
      // Once per stretch of absence, not every day of it.
      if (!test && last > since)
        return this.#quiet(a, test, `Still nothing about "${t.nothing_about}"; already told on ${shortLocal(new Date(last), tz)}.`);
      if (!test) setMemo(this.d.sql, a.id, { ...a.memo, fired_at: Date.now() });
      return {
        run: true,
        note: `Nothing about "${t.nothing_about}" has come up since ${shortLocal(new Date(since), tz)} (${t.for_days} days).`,
      };
    }
    if (t.kind === "event" && t.on === "calendar") return this.#calendarLook(a);
    if (t.kind !== "watch") return { run: true, note: "" };
    let text: string;
    try {
      const res = await this.d.fetch(t.url, { headers: { "user-agent": "Atlas" }, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (!res.ok) throw new Error(`${new URL(t.url).host} answered ${res.status}: ${body.slice(0, 200)}`);
      text = pageText(body);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(why.startsWith("Couldn't") || why.includes("answered") ? why : `Couldn't read ${new URL(t.url).host}: ${why}`);
    }
    const before = typeof a.memo.text === "string" ? a.memo.text : null;
    if (!test) setMemo(this.d.sql, a.id, { ...a.memo, text: text.slice(0, 20_000) });
    if (before == null) return this.#quiet(a, test, "First look: Atlas now knows what the page says, and watches for changes from here.");
    if (before === text.slice(0, 20_000)) return this.#quiet(a, test, "No change.");
    const change = diff(before, text);
    const decider = this.d.decider();
    if (!decider) return { run: true, note: `The page changed. What's new:\n${change}` };
    const p =
      (
        await decider.yesNo(`What was there before, and what's new on the page:\n${change}`, {
          matters: { instructions: `Does this change mean: ${t.matters}?` },
        })
      ).matters ?? 0;
    if (p < 0.5) return this.#quiet(a, test, `It changed, but not in a way that matters (${Math.round(p * 100)}% that it does).`);
    return { run: true, note: `The page changed in a way that matters (${Math.round(p * 100)}% sure). What's new:\n${change}` };
  }

  /**
   * What the intake took in (§10.4). A calendar change runs each automation
   * whose trigger follows the calendar, when the change has its words. The
   * intake's look is the one place calendar changes are noticed.
   */
  async sensed(rows: LogRow[]): Promise<void> {
    const changes = rows.filter((r) => r.body.source === "calendar");
    if (!changes.length) return;
    for (const a of listAutomations(this.d.sql)) {
      if (a.state !== "on" || a.when.kind !== "event" || a.when.on !== "calendar") continue;
      const about = a.when.about?.trim().toLowerCase();
      const hits = changes.filter(
        (r) =>
          !about ||
          String(r.body.text ?? describe(r))
            .toLowerCase()
            .includes(about),
      );
      if (hits.length)
        await this.run(a, { why: "calendar", context: `The calendar changed:\n${hits.map((r) => `- ${describe(r)}`).join("\n")}` });
    }
  }

  /** A calendar trigger's test: the changes the intake noticed in the last two weeks that have its words. */
  #calendarLook(a: Automation): { run: boolean; note: string } {
    const t = a.when as Extract<Automation["when"], { kind: "event" }>;
    const about = t.about?.trim().toLowerCase();
    const found = this.d.sql
      .exec<{ body: string }>(
        `SELECT body FROM log WHERE kind = 'sense' AND json_extract(body, '$.source') = 'calendar' AND at > ? ORDER BY seq DESC LIMIT 100`,
        Date.now() - 14 * 86_400_000,
      )
      .toArray()
      .map((r) => ({ body: parse<Record<string, unknown>>(r.body, {}) }))
      .filter(
        (r) =>
          !about ||
          String(r.body.text ?? describe(r))
            .toLowerCase()
            .includes(about),
      )
      .slice(0, 8);
    if (!found.length)
      return {
        run: true,
        note: `No calendar changes${about ? ` about "${t.about}"` : ""} in the last two weeks. It runs on the next one.`,
      };
    return {
      run: true,
      note: `The latest calendar changes${about ? ` about "${t.about}"` : ""}:\n${found.map((r) => `- ${describe(r)}`).join("\n")}`,
    };
  }

  #quiet(a: Automation, test: boolean, note: string): { run: boolean; note: string } {
    if (!test) {
      const row = append(this.d.sql, {
        actor: "atlas",
        kind: "automation.run",
        body: { automation_id: a.id, name: a.name, why: a.when.kind, test, ok: true, quiet: true, text: note },
      });
      this.d.rows([row]);
    }
    return { run: false, note };
  }
}

/** Whether a trigger looks at something before its steps run. */
const looksFirst = (a: Automation) =>
  a.when.kind === "watch" || a.when.kind === "absence" || (a.when.kind === "event" && a.when.on === "calendar");

export const TELL_AFTER = 2;
export const PAUSE_AFTER = 5;

const WHY: Record<Why, string> = {
  button: "the owner pressed Run",
  request: "the owner asked for it",
  schedule: "on its schedule",
  watch: "the page it watches changed",
  absence: "something it watches for didn't happen",
  event: "another automation finished",
  calendar: "the calendar changed",
  test: "a test run",
};

/** The lines that are new, and the lines that went, up to about 2,000 characters. */
export function diff(before: string, after: string): string {
  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  const added = after.split("\n").filter((l) => !old.has(l));
  const gone = before.split("\n").filter((l) => !now.has(l));
  const out = [...added.map((l) => `+ ${l}`), ...gone.map((l) => `- ${l}`)].join("\n");
  return out.length > 2_000 ? `${out.slice(0, 2_000)}…` : out;
}
