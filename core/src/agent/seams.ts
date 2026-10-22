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
  /** The `decide` role: undefined uses Workers AI's Clef, null means none. */
  decide: Decider | null | undefined;
  /** Cloudflare's web search: undefined uses the AI binding, null means none. */
  websearch: WebSearchBinding | null | undefined;
  /** The browser: undefined uses Browser Run, null means none. */
  browser: import("../browser").BrowserDriver | null | undefined;
  /** The workspace: undefined uses its Durable Object, null means none. */
  workspace: import("../agent").WorkspaceStub | null | undefined;
} = {
  makeBrain: null,
  calendar: undefined,
  fetch: null,
  embed: undefined,
  contextWindow: null,
  decide: undefined,
  websearch: undefined,
  browser: undefined,
  workspace: undefined,
};
