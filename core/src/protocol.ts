// What the app and the person agent say to each other over the one socket.
// Voice uses the same socket with the Agents SDK voice protocol; every Atlas
// message type starts with "atlas." so the two never collide.

import { z } from "zod";
import type { LogRow } from "./store/log";
import type { AgendaItem } from "./store/agenda";
import { BrainChoice, SettingsPatch } from "./store/settings";

export type { LogRow, AgendaItem };

// --- app -> agent ----------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  /** Sent on connect. `tz` is the browser's zone, used until the owner sets one. */
  z.object({ type: z.literal("atlas.hello"), tz: z.string().max(64).optional() }),
  /** The owner says something in text. `client_id` lets the app match its optimistic bubble. */
  z.object({ type: z.literal("atlas.say"), text: z.string().min(1).max(20_000), client_id: z.string().max(64) }),
  /** Undo from a receipt. */
  z.object({ type: z.literal("atlas.undo"), log_id: z.string().max(64) }),
  /** Older thread rows, for scrolling back. */
  z.object({ type: z.literal("atlas.more"), before_seq: z.number().int() }),
  z.object({ type: z.literal("atlas.settings.update"), patch: SettingsPatch }),
  /** Set or clear (null) a secret. */
  z.object({
    type: z.literal("atlas.secret.set"),
    secret: z.discriminatedUnion("name", [
      z.object({ name: z.literal("elevenlabs_api_key"), value: z.string().min(8).max(200).nullable() }),
      z.object({
        name: z.literal("icloud"),
        value: z.object({ username: z.string().min(3).max(200), app_password: z.string().min(4).max(64) }).nullable(),
      }),
    ]),
  }),
  /** "Sign in with ChatGPT": start, then paste the address the browser landed on. */
  z.object({ type: z.literal("atlas.chatgpt.start") }),
  z.object({ type: z.literal("atlas.chatgpt.finish"), url: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("atlas.chatgpt.cancel") }),
  z.object({ type: z.literal("atlas.chatgpt.signout") }),
  /** Live checks for Settings (§22: every check is a live test). */
  z.object({
    type: z.literal("atlas.test"),
    what: z.enum(["calendar", "brain", "voice"]),
    /** Echoed back on the result, so the app knows which button it answers. */
    ref: z.string().max(64).optional(),
    /** A brain to test: a spot in a saved chain, or an unsaved choice. */
    role: z.enum(["main", "voice"]).optional(),
    index: z.number().int().optional(),
    choice: BrainChoice.optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- agent -> app ----------------------------------------------------------

/** Settings as the app sees them: values, plus whether each secret is set (never the secret). */
export interface SettingsView {
  settings: import("./store/settings").Settings;
  secrets: { elevenlabs_api_key: boolean; icloud: { username: string } | null };
  chatgpt: ChatGPTView;
  /** Provider health, by "provider:model". */
  health: Record<string, { ok: boolean; reason?: string; checked_at: number }>;
}

export type ChatGPTView =
  | { state: "signed_out" }
  /** Waiting for the owner to sign in at `authorize_url` and paste back where they landed. */
  | { state: "pending"; authorize_url: string; expires_at: number; error?: string }
  | { state: "signed_in"; email: string | null; models: string[] }
  | { state: "error"; message: string };

export type RunState = "running" | "replied" | "deferred" | "failed";

export type ServerMessage =
  | {
      type: "atlas.snapshot";
      thread: LogRow[];
      agenda: AgendaItem[];
      view: SettingsView;
      running: Array<{ run_id: string; surface: string }>;
    }
  /** A new or older thread row. The saved truth: it replaces any streamed text for its run. */
  | { type: "atlas.rows"; rows: LogRow[]; older?: boolean; has_more?: boolean }
  /** Streamed reply text for a run in progress. A progress hint only (§4.1). */
  | { type: "atlas.delta"; run_id: string; text: string }
  /** What Atlas is doing right now in a run, such as "Checking your calendar". */
  | { type: "atlas.status"; run_id: string; text: string | null }
  | { type: "atlas.run"; run_id: string; state: RunState; surface: string; client_id?: string }
  | { type: "atlas.agenda"; agenda: AgendaItem[] }
  | { type: "atlas.view"; view: SettingsView }
  | { type: "atlas.test.result"; what: string; ref?: string; ok: boolean; message: string; detail?: unknown }
  | { type: "atlas.error"; message: string };
