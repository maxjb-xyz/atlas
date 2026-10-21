// What Settings shows (values, whether each secret is set, sign-in state and
// brain health) and its live tests (§22: every check is a live test).

import type { BrainRouter } from "../brains/router";
import { type Brain, brainKey } from "../brains/types";
import { CalendarError, type ICloudCredentials } from "../calendar/types";
import type { ClientMessage, SettingsView } from "../protocol";
import type { Sql } from "../store/db";
import { type BrainChoice, getSecret, readSettings } from "../store/settings";
import type { CalendarSense } from "./calendar";
import type { ChatGPTSignIn } from "./chatgpt";

export function settingsView(sql: Sql, parts: { chatgpt: ChatGPTSignIn; calendar: CalendarSense; router: BrainRouter }): SettingsView {
  const icloud = getSecret<ICloudCredentials>(sql, "icloud");
  return {
    settings: readSettings(sql),
    secrets: {
      elevenlabs_api_key: Boolean(getSecret(sql, "elevenlabs_api_key")),
      icloud: icloud ? { username: icloud.username, refused: parts.calendar.refusal() } : null,
    },
    chatgpt: parts.chatgpt.view(),
    health: parts.router.snapshot(),
  };
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  detail?: unknown;
}

export interface TestDeps {
  sql: Sql;
  calendar: CalendarSense;
  router: BrainRouter;
  makeBrain(choice: BrainChoice): Brain | null;
  /** Speaks the sample out loud, and says which voice and how fast. */
  speakSample(): Promise<TestOutcome>;
}

export async function liveTest(deps: TestDeps, msg: Extract<ClientMessage, { type: "atlas.test" }>): Promise<TestOutcome> {
  const settings = readSettings(deps.sql);
  const choice = msg.what === "brain" ? (msg.choice ?? settings.brains[msg.role ?? "main"][msg.index ?? 0]) : undefined;
  try {
    if (msg.what === "calendar") {
      const source = deps.calendar.source(settings);
      if (!source) return { ok: false, message: "Add your Apple ID and an app-specific password first." };
      const c = await source.check().catch((err: unknown) => {
        throw err instanceof CalendarError && err.code === "auth"
          ? new CalendarError(`${err.message} ${deps.calendar.shape()}`, "auth")
          : err;
      });
      return {
        ok: true,
        message: `Found ${c.calendars.length} calendars and ${c.events_next_30_days} events in the next 30 days.`,
        detail: c,
      };
    }
    if (msg.what === "brain") {
      if (!choice) return { ok: false, message: "There's no brain at that spot." };
      const brain = deps.makeBrain(choice);
      if (!brain) return { ok: false, message: "Sign in with ChatGPT first." };
      const t0 = Date.now();
      let text = "";
      let firstMs: number | null = null;
      for await (const ev of brain.stream({
        system: "You are being tested. Reply with one short sentence.",
        messages: [{ role: "user", content: "Say hello." }],
        tools: [],
        effort: "low",
        signal: AbortSignal.timeout(30_000),
      })) {
        if (ev.type === "text") {
          firstMs ??= Date.now() - t0;
          text += ev.text;
        }
      }
      deps.router.markOk(brain);
      return {
        ok: true,
        message: `${brainKey(choice)} answered: first words in ${firstMs ?? "?"} ms, done in ${Date.now() - t0} ms.`,
        detail: { text: text.slice(0, 200), first_ms: firstMs },
      };
    }
    return await deps.speakSample();
  } catch (err) {
    if (choice) deps.router.markFailed(choice, err);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
