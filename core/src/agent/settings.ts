// What Settings shows (values, whether each secret is set, sign-in state and
// brain health) and its live tests (§22: every check is a live test).

import { dataKeyView } from "../store/sealed";
import { sensesView } from "../intake";
import { openTasks, taskView } from "../tasks";
import { zoneOf } from "../time";
import type { BrainRouter } from "../brains/router";
import { type Brain, brainKey } from "../brains/types";
import type { ClientMessage, SettingsView } from "../protocol";
import type { Sql } from "../store/db";
import { runCharacterCheck, summary } from "../character-check";
import { type BrainChoice, getSecret, readSettings, type Settings } from "../store/settings";
import type { StoredPasskey } from "../passkeys";
import { getState } from "../store/state";
import type { CalendarSense } from "./calendar";
import { setupView } from "./setup";
import { focusNow, interruptionsToday, pushDevices } from "../outbox";
import { ASKS, trustTable } from "../approvals";
import { webhooks, webhookView } from "../webhooks";
import { vault, vaultView } from "../vault";
import type { VapidKeys } from "../push";
import type { ChatGPTSignIn } from "./chatgpt";
import { here, nearest, pins } from "../location";
import { accountName, installed, providing } from "../extensions";
import type { ExtensionDesk } from "./extensions";
import type { MailDesk } from "./mail";
import type { UpdateDesk } from "./updates";
import { faces } from "../faces";
import { members } from "../members";
import { getRecord } from "../store/records";
import { links } from "./channels";
import { nodes, nodeView } from "../nodes";
import type { LocationView } from "../protocol";

export function settingsView(
  sql: Sql,
  parts: {
    chatgpt: ChatGPTSignIn;
    calendar: CalendarSense;
    router: BrainRouter;
    extensions: ExtensionDesk;
    mail?: MailDesk;
    updates?: UpdateDesk;
  },
): SettingsView {
  const passkeys = (getState<StoredPasskey[]>(sql, "passkeys") ?? [])
    .filter((p) => !p.member)
    .map((p) => ({
      id: p.id,
      name: p.name,
      created_at: p.created_at,
      last_used: p.last_used,
    }));
  const refusal = parts.calendar.refusal();
  const provider = parts.calendar.provider();
  const settings = readSettings(sql);
  return {
    settings,
    secrets: {
      elevenlabs_api_key: Boolean(getSecret(sql, "elevenlabs_api_key")),
      anthropic_api_key: Boolean(getSecret(sql, "anthropic_api_key")),
      sealed: dataKeyView(),
    },
    calendar: {
      provider: provider ? { id: provider.id, name: provider.name } : null,
      refused: refusal ? { ...refusal, note: parts.calendar.note(refusal, settings) } : null,
      // Every calendar account, each with its own refusal (§17).
      providers: parts.calendar.providers().map((p) => {
        const r = parts.calendar.refusal(p.id);
        return {
          id: p.id,
          name: p.name,
          account: accountName(p),
          calendars: parts.calendar.names()[p.id] ?? [],
          refused: r ? { ...r, note: parts.calendar.note(r, settings) } : null,
        };
      }),
    },
    extensions: parts.extensions?.views() ?? [],
    members: members(sql).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      joined_at: m.joined_at,
      invited_at: m.invited_at,
      invite_open: !m.joined_at && m.invite_expires > Date.now(),
    })),
    me: getState<{ id: string; name: string; role: "admin" | "member"; owner: string }>(sql, "member_of"),
    faces: faces(sql).map((f) => ({
      ...f,
      people_names: f.people.map((id) => getRecord(sql, id)?.name ?? "someone forgotten"),
      pull_names: f.pull_people.map((id) => getRecord(sql, id)?.name ?? "someone forgotten"),
    })),
    channels: providing(sql, "channel").map((e) => {
      const l = links(sql)[e.id];
      return { ext: e.id, name: e.name, linked: l ? { name: l.name, at: l.at } : null };
    }),
    mail: parts.mail?.view() ?? {
      address: null,
      domain: null,
      on_subdomain: false,
      sending: null,
      sending_ok: false,
      sending_note: null,
      permissions: [],
      token_links: { cloudflare: "", other: "" },
      senders: [],
    },
    webhooks: webhooks(sql).map(webhookView),
    vault: vault(sql).map(vaultView),
    permissions: {
      kinds: ASKS,
      trusted: Object.entries(trustTable(sql))
        .filter(([, t]) => t.trusted_at != null)
        .map(([key, t]) => ({ key, name: t.name, since: t.trusted_at! })),
    },
    push: {
      public_key: getSecret<VapidKeys>(sql, "push_vapid")?.public ?? null,
      devices: pushDevices(sql).map((d) => ({ id: d.id, name: d.name, added_at: d.added_at, last_seen: d.last_seen })),
      today: interruptionsToday(sql, zoneOf(settings)),
    },
    focus: focusNow(sql),
    chatgpt: parts.chatgpt.view(),
    health: parts.router.snapshot(),
    passkeys,
    setup: setupView(sql),
    location: locationView(sql),
    nodes: nodes(sql).map(nodeView),
    senses: sensesView(sql),
    tasks: openTasks(sql).map(taskView),
    updates: parts.updates?.view() ?? {
      running: { version: "unknown", commit: null, version_id: null },
      token: false,
      token_link: "",
      script: null,
      looked_at: null,
      look_error: null,
      newest: null,
      ready: false,
      run: null,
      rollback: null,
      foreign: null,
      busy: false,
    },
  };
}

function locationView(sql: Sql): LocationView {
  const h = here(sql);
  // Set up when a location extension is on and its setup ran (it keeps its login as its state).
  const app = installed(sql).find((e) => e.state === "on" && e.manifest.provides.includes("location"));
  const all = pins(sql);
  const f = h.fix;
  const n = f && !h.place ? nearest(all, f) : null;
  return {
    set_up: app?.data != null,
    made_at: app?.data != null ? app.updated_at : null,
    fix: f
      ? {
          at: f.at,
          acc: Math.round(f.acc),
          ...(f.batt != null ? { batt: f.batt } : {}),
          ...(f.charging != null ? { charging: f.charging } : {}),
          ...(f.conn ? { conn: f.conn } : {}),
        }
      : null,
    place: h.place ? { name: h.place.name, since: h.place.since } : null,
    near: n ? { name: n.pin.name, m: Math.round(n.m) } : null,
    refused: h.refused,
    pins: all.length,
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
  /** Brains that can judge the character check without being checked themselves. */
  judges(): Brain[];
  /** Speaks the sample out loud, and says which voice and how fast. */
  speakSample(): Promise<TestOutcome>;
  /** Atlas's system prompt for a text reply, with an unsaved character when one is given. */
  systemFor(character?: Settings["character"]): string;
  /** Sends a test notification to one device. */
  push(device: string | undefined): Promise<TestOutcome>;
  /** A real web search with the chosen provider. */
  search(): Promise<TestOutcome>;
  /** Calls a webhook now, on the owner's own word. */
  webhook(id: string | undefined): Promise<TestOutcome>;
  /** Looks up a place, a route and the weather, with the maps the owner picked. */
  maps(): Promise<TestOutcome>;
}

/** What the Character page's sample answers, so the owner hears the character before saving it. */
export const SAMPLE_PROMPT = "I skipped the gym again today.";

export async function liveTest(deps: TestDeps, msg: Extract<ClientMessage, { type: "atlas.test" }>): Promise<TestOutcome> {
  const settings = readSettings(deps.sql);
  const choice = msg.what === "brain" ? (msg.choice ?? settings.brains[msg.role ?? "main"][msg.index ?? 0]) : undefined;
  try {
    if (msg.what === "calendar") {
      const source = deps.calendar.source(settings);
      if (!source) return { ok: false, message: "Install a calendar extension (iCloud) in Settings → Extensions first." };
      const c = await source.check();
      return {
        ok: true,
        message: c.text ?? `Found ${c.calendars?.length ?? 0} calendars and ${c.events_next_30_days ?? 0} events in the next 30 days.`,
        detail: c,
      };
    }
    if (msg.what === "maps") return await deps.maps();
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
    if (msg.what === "character") {
      const brains = [...settings.brains.main, ...settings.brains.voice]
        .filter((c, i, all) => all.findIndex((x) => brainKey(x) === brainKey(c)) === i)
        .map((c) => deps.makeBrain(c))
        .filter((b): b is Brain => b != null);
      const checks = await runCharacterCheck(brains, deps.systemFor(), { judges: deps.judges() });
      const ok = checks.length > 0 && checks.every((c) => !c.note && c.results.every((r) => r.verdict.passed));
      return { ok, message: `Character check: ${summary(checks)}.`, detail: checks };
    }
    if (msg.what === "push") return await deps.push(msg.device);
    if (msg.what === "webhook") return await deps.webhook(msg.id);
    if (msg.what === "search") return await deps.search();
    if (msg.what === "sample") {
      const choice = settings.brains.main.map((c) => deps.makeBrain(c)).find((b) => b != null);
      if (!choice) return { ok: false, message: "There's no brain set up to answer." };
      let text = "";
      for await (const ev of choice.stream({
        system: deps.systemFor(msg.character),
        messages: [{ role: "user", content: SAMPLE_PROMPT }],
        tools: [],
        effort: "low",
        signal: AbortSignal.timeout(30_000),
      })) {
        if (ev.type === "text") text += ev.text;
      }
      return { ok: true, message: text.trim(), detail: { prompt: SAMPLE_PROMPT, brain: brainKey(choice) } };
    }
    return await deps.speakSample();
  } catch (err) {
    if (choice) deps.router.markFailed(choice, err);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
