// Test seams: fake brains, calendars, embeddings and HTTP instead of real
// providers. Only the tests set these (CLAUDE.md: never call a real provider
// from tests).

import type { Decider } from "../brains/decide";
import type { Embedder } from "../brains/embed";
import type { Brain } from "../brains/types";
import type { CalendarSource } from "../calendar/types";
import type { BrainChoice } from "../store/settings";
import type { WebSearchBinding } from "../web";

export const seams: {
  makeBrain: ((choice: BrainChoice) => Brain | null) | null;
  calendar: CalendarSource | null | undefined;
  fetch: typeof fetch | null;
  /** The `embed` role: undefined uses Workers AI, null means none. */
  embed: Embedder | null | undefined;
  /** A smaller context window, so tests can reach compaction with a few messages. */
  contextWindow: number | null;
  /** The `extract` role: undefined uses Workers AI's Clairic, null means none. */
  extract: import("../brains/extract").Extractor | null | undefined;
  /** Voice notes and photos on chat channels: undefined uses Workers AI (and ElevenLabs when set up). */
  notes: import("../voice/providers").Notes | undefined;
  /** The `decide` role: undefined uses Workers AI's Clef, null means none. */
  decide: Decider | null | undefined;
  /** Cloudflare's web search: undefined uses the AI binding, null means none. */
  websearch: WebSearchBinding | null | undefined;
  /** The browser: undefined uses Browser Run, null means none. */
  browser: import("../browser").BrowserDriver | null | undefined;
  /** The workspace: undefined uses its Durable Object, null means none. */
  workspace: import("../agent").WorkspaceStub | null | undefined;
  /** Which Atlas is running (§23.2): undefined reads the app's version.json and the version metadata binding. */
  running: import("../updates").Running | undefined;
  /** Connected MCP servers: undefined uses the Agents SDK's client, null means none. */
  mcp: import("../mcp").McpClient | null | undefined;
  /**
   * Runs an extension's call outside its sandbox, for tests (a Dynamic Worker's gate would reach the real
   * service). Null uses the sandbox.
   */
  extension:
    | ((o: {
        id: string;
        method: string;
        args: unknown[];
        ctx: Record<string, unknown>;
        secrets: Record<string, string>;
        hosts: string[];
      }) => Promise<unknown>)
    | null;
} = {
  makeBrain: null,
  calendar: undefined,
  fetch: null,
  embed: undefined,
  contextWindow: null,
  decide: undefined,
  extract: undefined,
  notes: undefined,
  websearch: undefined,
  browser: undefined,
  workspace: undefined,
  running: undefined,
  mcp: undefined,
  extension: null,
};
