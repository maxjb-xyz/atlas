// Test seams: fake brains, calendars, embeddings and HTTP instead of real
// providers. Only the tests set these (CLAUDE.md: never call a real provider
// from tests).

import type { Brain } from "../brains/types";
import type { CalendarSource } from "../calendar/types";
import type { BrainChoice } from "../store/settings";

export const seams: {
  makeBrain: ((choice: BrainChoice) => Brain | null) | null;
  calendar: CalendarSource | null | undefined;
  fetch: typeof fetch | null;
} = { makeBrain: null, calendar: undefined, fetch: null };
