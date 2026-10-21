# Handoff: M0 done, M1 next

**Date:** 2026-10-21. **From:** the M0 build. **For:** whoever builds M1, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M0.md](M0.md) first. This page covers what M0 left behind: where things stand, how we work now, what's still open, and a suggested order for M1.

## 1. Where things stand

- **M0 is done**, signed off by smoke test on the owner's deployment ([M0.md §4](M0.md#4-the-smoke-test-and-what-it-found)).
- **The deployment** is the owner's own Cloudflare account, on Workers Paid, at a workers.dev address. The owner deploys; the build sandbox has no Cloudflare, OpenAI, Apple or ElevenLabs accounts.
- **The code** is on branch `claude/magical-cerf-2p1psz` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M1.
- **The checks** are `npm run check`: typecheck, 77 tests in the Workers runtime, and the app build. All pass.
- **The size** is about 4,600 lines of core runtime against the 25k budget (rule 4), plus about 1,100 in the app.
- **Working today:** text and voice on one socket, ChatGPT plan sign-in and Workers AI with fallback, `calendar_read` on iCloud, reminders with receipts and undo, the log, runs with saved final states, and settings with live tests.

## 2. How we work now

**Smoke tests instead of a week of use.** VISION rule 7 changed on 2026-10-21: a milestone is done when its smoke test passes on the owner's real deployment, not after a week of living with it. A smoke test is a short, hand-run list of day-in-the-life checks covering every surface and failure path the milestone adds. M0's is in [M0.md §4](M0.md#4-the-smoke-test-and-what-it-found). For M1:

- Write M1's smoke test first, from the M1 scope, before the build. Section 6 has a starting draft.
- Keep M0's smoke test as a regression list. Run both after any deploy that touches the core.
- The owner keeps using Atlas while M1 is built. Anything that feels wrong is a fix, under rule 1: the character, the context, a tool's description or the tool, never a filter.

**Make every failure explain itself.** Most M0 bugs were only visible on the real deployment, and each took a round trip with the owner to find. The ones that were quick to fix were the ones whose errors named the real cause: the HTTP status, the server, and what the provider said. So:

- Never collapse an error into a generic "couldn't connect". Keep the status, the host and the provider's own words, both in the message the owner sees and in the Worker log (`console.error` with a JSON line).
- When a credential is refused, say what Atlas holds without the secret (the account name, and the length and form of the password).
- Fakes in tests must behave like the real runtime where it matters. Workers' `fetch` throws "Illegal invocation" when called as a method; a test fake that didn't care hid that bug.

**Research before guessing.** Three M0 problems were answered by documentation, not by code: OpenAI's official plan usage, the voice library's sentence chunker, and its streaming TTS. Read the vendor docs and the installed package source before changing code.

## 3. Open issues carried into M1

### 3.1 Voice latency (an M0 exit check that isn't met)

At sign-off, a calendar question by voice had its status line at 2.5 s and its answer at 6.6 s, counted from when Atlas had the owner's words. The target is a status line within 1 s. Almost all of the 2.5 s is the ChatGPT model thinking before it says or does anything. In order of expected payoff:

1. **Run the benchmark sweep** (`npm run bench -- --url … --sweep`) and pick the `voice` brain from data. Workers AI models run on the same network and may start within a second. Then set defaults in `core/src/store/settings.ts` and VISION §18 together.
2. **Less thinking for voice.** Voice requests ask ChatGPT for `reasoning: { effort: "low" }` (`core/src/brains/chatgpt.ts`). Lower settings may be supported for the plan's models; check OpenAI's docs for the model, not memory.
3. **Prompt caching.** The context's stable block comes first (`core/src/context.ts`) so it can be cached; confirm the provider actually reports cached tokens (`usage.cached` on `message.out` rows).
4. **Start on Flux's early end-of-turn signal** (`eagerEotThreshold` in `core/src/voice/providers.ts`). Old Atlas did this (`atlas-legacy/workers/voice/src/stt.ts`); it needs care to drop a speculative start when the owner keeps talking.

Every spoken reply records `status_ms`, `answer_ms` and the tools that ran (on its `message.out` row and the `voice.metrics` row), and the app shows them under the reply.

### 3.2 iCloud calendar reliability

A working app-specific password stopped working later, and regenerating it fixed it once. Apple gives a plain 401 in every case, so the cause isn't known. Two candidates:

- **Atlas's own retries.** Before the fix, a refused login was retried several times per reply. Reports link repeated failed logins to Apple locking accounts. Atlas now stops asking after a refusal and signs in far less (M0.md §6).
- **Logins from Cloudflare's shared addresses.** Old Atlas ran on the owner's machine and never had this problem.

**The deciding test is still pending:** the owner runs the refused password from home with `curl` (below). 207 from home means Apple is refusing Cloudflare; 401 means the password was revoked.

```sh
curl -s -o /dev/null -w "%{http_code}\n" -u 'APPLE_ID:xxxx-xxxx-xxxx-xxxx' -X PROPFIND -H 'Depth: 0' https://caldav.icloud.com/
```

If Apple is refusing Cloudflare, a password can't be the long-term route. Options to research, not yet chosen:

- an iCloud published calendar link (read-only, no password);
- reading the calendar on a node (VISION §16.3, M4), pulled forward for the calendar only;
- Google Calendar over OAuth, for owners who use it.

### 3.3 Smaller items

- **ChatGPT sign-in ends with a paste**, because OpenAI only redirects to `127.0.0.1`. The desktop app (Tauri) could catch the redirect itself, and OpenAI may allow other redirects later ([interest form](https://developers.openai.com/siwc/token-sharing-open-source) for hosted apps).
- **ChatGPT token refresh** works per OpenAI's docs and tests, but wasn't confirmed on the real deployment on its own.
- **Workers AI tool calls** weren't tried on the real deployment with a lookup.
- **Bench turns land in the real thread.** Bench mode (§23.7) should mark them.
- **Secrets table used for non-secrets.** `icloud_calendars`, `icloud_refused` and `chatgpt_client` live in the `secrets` table for convenience. The vault (M3) or a small `state` table should take them.
- **`core/src/agent.ts` is about 900 lines.** It holds the socket protocol, settings, ChatGPT sign-in, the calendar guard and live tests. Split those out before M1 adds more (for example `agent/settings.ts`, `agent/chatgpt.ts`, `agent/calendar.ts`).
- **The app is a bare thread.** M1 replaces it with the UI v1 shell; reuse `app/src/connection.ts`, which owns the socket and the thread state.
- **Project Think.** M0 chose the plain Agents SDK with its own loop, because Think keeps its own message store (a second log). Revisit for compaction and helpers in M1 only if it can use Atlas's log as its store.

## 4. M1: the companion

From VISION §25, M1 proves Atlas feels like Atlas in conversation and knows your stuff:

- **The full loop:** budgets (done in M0), compaction (about 70% of the context window, a silent save-what-matters pass, then a summary; §4.1), and basic helpers (§8.1).
- **The log, records and recall:** writing records during the turn with a chip (§5.4), and the `recall` tool (§5.3): keyword, meaning, time and links, with sources. Embeddings on Workers AI.
- **Areas** (§6): tagging with the `decide` role, the scope switcher, per-area settings.
- **The character** (§23.1): the Character page with presets, and old Atlas's character eval.
- **The UI v1 shell** (§21, [docs/ui/](ui/README.md)): Home with the stage and console, Inbox, Agenda, Automations, Library, History, and settings, with the first views, receipts, and the Graphite and Daylight themes.
- **Setup steps 1 to 5** (§22), with passkeys replacing the owner secret.

### Suggested order

1. **Groundwork:** merge M0; split `agent.ts`; add a `state` table; decide the voice brain from the benchmark (§3.1).
2. **Memory:** record writing in the turn, then `recall` with embeddings. This is what "knows your stuff" rests on, and the UI's Library needs it.
3. **Compaction**, once long threads exist to test it on.
4. **Areas**, after records exist to tag.
5. **The UI v1 shell**, page by page, starting with Home (stage and console) on the existing socket protocol, then History (it's the log), then Library and Agenda.
6. **Setup and passkeys** last, since setup shows off everything above.
7. **Helpers** where a feature needs one (long recall, reading big documents), not before.

Keep the four invariants as you go: one loop, one log, one clock, one way out. A new mechanism replaces an old one or doesn't go in.

## 5. Where to put things

| To add | Do this |
|---|---|
| A tool | `core/src/tools/<name>.ts` with `defineTool`: a zod input, a `kind` (§12.1), an optional `status` line, and a receipt when the owner should see it happened. Add it to `TOOLS` in `agent.ts`. |
| A brain provider | Implement `Brain` (`core/src/brains/types.ts`): stream text, `tool_start` as early as the provider allows, `tool_call`, and `done`. Map the provider's documented errors to `BrainError` with a plain reason. |
| A log kind | Add it to `LogKind` in `core/src/store/log.ts`, and to `isThreadRow` and `THREAD_KINDS` if the thread shows it. |
| A setting | Add it to the zod `Settings` in `core/src/store/settings.ts` with a default, and give it a place in the app (rule 6). |
| A table or column | Append a new entry to `MIGRATIONS` in `core/src/store/db.ts`. Never edit a shipped entry. |
| An app message | Add it to `ClientMessage` or `ServerMessage` in `core/src/protocol.ts`; every Atlas message type starts with `atlas.`. |
| A test | Fake brains and calendars go through `seams` in `agent.ts`; fake HTTP through `seams.fetch`. Make fakes as strict as the real thing. |

## 6. A first draft of M1's smoke test

Finish this from the final M1 scope before building.

- [ ] **Setup:** a fresh deploy reaches a passkey, the name and voice, a brain, calendar and email connections, and Atlas's first look, in under 10 minutes, with nothing in a terminal after deploy.
- [ ] **Memory:** "I'm vegetarian" saves a record with a chip. A new conversation later uses it without reciting it. "Forget that" removes it, and History shows both.
- [ ] **Recall:** "what did I say about the Riverside shoot last week?" finds it and cites the source.
- [ ] **Areas:** a work email lands in the right area. Moving its chip re-tags related records, and the scope switcher filters every page.
- [ ] **Compaction:** a very long conversation keeps going without losing an earlier commitment.
- [ ] **UI:** each of the six places works in Graphite and Daylight, at desktop and phone width. A receipt opens into its view on the stage.
- [ ] **Regression:** M0's smoke test still passes.
