# Handoff: M2 closed, M3 next

**Date:** 2026-10-22. **From:** the M2 build. **For:** whoever builds M3, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M2.md](M2.md) first. This page covers what M2 left behind: where things stand, what we learned, what's still open, and a suggested order for M3.

## 1. Where things stand

- **M2 is closed** by the owner, with the calendar steps open ([M2.md §4](M2.md#4-found-on-the-real-deployment)). The calendar still isn't connected, so M2's steps 20 and the calendar part of 39, and M1's calendar steps, join M3's smoke test as regression (§6).
- **The deployment** is the owner's own Cloudflare account at a workers.dev address, on **Workers Paid** (decided in M2), so Kimi K2.6, sandboxes and the rest of M3's platform pieces are available. The owner deploys; the build sandbox has no Cloudflare, OpenAI, Apple or ElevenLabs accounts.
- **The code** is on branch `claude/compassionate-knuth-sx3fhq` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M3.
- **The checks** are `npm run check`: typecheck, 188 tests in the Workers runtime, and the app build. All pass.
- **The size** is about 13,500 lines of core runtime against the 25k budget (rule 4), plus about 7,900 in the app. M3 is the biggest milestone yet, so spend the remaining lines carefully (§4).
- **Working today**, on top of M1:
  - the stage's `show` tool with area, person, list, table, draft, plan, automation, approval and page views, compact and expanded;
  - pages: Keep on any view, versions, the owner's editor, Atlas's `page_save` and `page_read`, Library → Pages;
  - the outbox for real: one channel per message, push notifications to the device used last, quiet hours, focus, a daily interruption budget, and a delivery receipt for everything beyond the thread;
  - approvals with earned trust, guarding webhook calls and deleting a record for good: one card per plan, Inbox, the stage, push's Approve button, voice and text, hold to confirm, expiry;
  - the agenda's promises, kept by a run of Atlas's own, and safe across restarts;
  - automations with all five triggers (request, schedule, watch, absence, and events: another automation finishing or the calendar changing), test runs, paused starts, run history, failure counting, and suggestions from repeated requests;
  - the default routines, off until the owner turns them on in setup's last step.

## 2. What M2 taught us

M0's and M1's lessons still hold: make every failure explain itself, research before guessing, keep fakes as strict as the real runtime, test against data the last version saved, and drive the UI in a browser before calling it done. M2 added these:

- **Atlas offers what its tools can't do.** Asked for lunch places, it asked the owner for a Maps link it had no way to open. The character now says that what Atlas can reach is what its tools reach (M2.md §4). When M3 adds the web, check the reverse too: that Atlas uses search instead of asking for links.
- **Never change a migration a database might already have.** An edit to an unshipped migration still broke a local database that had run the old one, and inserts failed. Add a new migration (`ALTER TABLE`) instead, even before the first deploy.
- **Don't swallow errors in start-up work.** The routines were made inside a catch-all meant for name clashes, so the broken insert above failed silently and was marked as done. Check for the expected case first, and let the rest reach the Worker log.
- **Things made on start appear in every test.** The default routines exist in every test's agent, so a test that made its own "Morning brief" clashed by name. Pick test names that defaults won't use.
- **A new setup step reopens setup once.** Adding "Your routines" made every finished setup unfinished, so the owner lands on the new step after the deploy. That's the way to introduce a new choice, but say so in the deploy notes.
- **Checking by hand still needs a fake brain.** Workers AI can't answer locally, so browser checks used a temporary scripted brain patched into `#makeBrain` (`core/src/agent.ts`), switched on from `.dev.vars`. It's a local patch, never committed (no behavior flags). Delete `.dev.vars` afterwards. Stop `wrangler dev` with its process ids from `pgrep -fa wrangler`, not `pkill -f wrangler`, which also matches the shell running the command.

## 3. Open issues carried into M3

### 3.1 The calendar

Unchanged from [HANDOFF-M2.md §3.1](HANDOFF-M2.md#31-icloud-refuses-atlass-sign-in): iCloud refused Atlas's sign-in, and the owner chose to wait. Settle it early in M3 if the owner wants calendar features to land: the decisive test, and the three ways out (public calendar links, a relay on the owner's Mac, Google Calendar), are there. Waiting on it: M2's calendar trigger (step 20), the calendar part of the routines (step 39), and M1's calendar steps.

### 3.2 Not yet checked on the deployment

- **Push on each device,** iPhone especially: Apple's push service is stricter about the sender than Google's ([M2.md §3](M2.md#3-deploy-it)).
- **Webhooks from Cloudflare** reaching the owner's services.

Both are in M2's smoke test (steps 26 and 33) and stay in M3's regression list.

### 3.3 Voice latency (an M0 exit check that still isn't met)

At M0's sign-off, a calendar question by voice had its status line at 2.5 s and its answer at 6.6 s, against a target of a status line within 1 s. M1 and M2 didn't work on it. [HANDOFF-M1.md §3.1](HANDOFF-M1.md#31-voice-latency-an-m0-exit-check-that-isnt-met) has the levers. On Workers Paid every model is available, so run the benchmark sweep and pick the voice brain from data. M3's web tools will add slow lookups to voice turns, which makes the status line matter more.

### 3.4 Smaller items

- **Export doesn't exist yet** (VISION §23.4). When it comes, it includes pages.
- **Per-area autonomy** (VISION §12.1: each area raising or lowering the approval defaults) isn't built. It belongs in Library → Areas with the other settings that control what leaves Atlas.
- **Money approvals** have nothing to guard yet. The first tool that spends (M3's browser or vault, or M5) adds the money kind: always asks, shows the amount, hold to confirm.
- **The interruption budget is a fixed number.** Learning it from how the owner reacts, and focus judged from calendar, location and devices, come with the senses (M4).
- **Suggestions match words, not meaning.** Meaning search over the owner's requests could use the embeddings recall already keeps.
- **Markdown headings render as bold text**, in pages too. Fine in chat; a page could use real headings.
- **From M1, still open:** a helper resumed after a restart logs its cut-off step twice; History's "Show earlier" starts over when new rows arrive; ChatGPT sign-in ends with a paste; benchmark turns land in the real thread.

## 4. M3: hands

From VISION §25, M3 proves that Atlas **finishes unfamiliar tasks**. It adds:

- **the web** (§9.1): search and fetch, with sources kept. This is what the owner asked about at M2's close: it's M3's to build, not missing from M2;
- **the workspace** (§9.1): a Cloudflare Sandbox per person, with a shell, Python, Node, files and a persistent `/workspace`, network access granted per website domain (approved once, remembered), a live terminal and a file browser in the app;
- **the browser** (§9.1): Browser Run, with its live view on the stage and "take over" for logins and captchas;
- **Code Mode** (§9.1): one small program that calls many tools at once, run in a Dynamic Worker;
- **the vault** (§15): secrets stored by name, filled in at the last step, tied to a site, the first use on each site asks, every use logged;
- **skills and learning** (§9.3): SKILL.md skills, drafted after accepted tasks, found again through an index, patched with history, tested, and shown on a Skills page;
- **finding a way** (§9.2): persistence as character, and growing its own abilities (an MCP server, a skill, an extension) with the owner's OK;
- **M3's stage views** (§21.6): live browser, research (an answer with sources), document, compare, chart, code, and the custom kit, small apps and MCP Apps;
- **files** (§21.7): generated in the sandbox, stored in R2, beside pages in Library.

### Suggested order

1. **Groundwork:**
   - merge M2;
   - settle the calendar route with the owner (§3.1), or confirm it keeps waiting;
   - choose the web search provider with the owner. Cloudflare has no search API of its own; the candidates are search APIs with a key (Brave Search, Exa, Tavily and the like). Compare price, quality and limits before proposing one, and check what the plan includes;
   - write M3's smoke test (`docs/M3.md`) from the draft in §6.
2. **The web first:** `web_search` and `web_fetch` tools, with sources kept on each result, and the research view (an answer with its sources) on the stage. Before the first search leaves, build the outbox's **public-query check** (VISION §4.4: private details never go into a web search or a map query). A search is a look, but its query leaves Atlas, so it goes through the way out. Fetch can reuse the page-to-text step automations' watches already have (`pageText` in `core/src/agent/automations.ts`).
3. **The workspace:** the Sandbox behind a small interface (VISION §19.3), files in R2, network rules per domain approved once, then the terminal and file browser in the app, and the document, code and chart views. Files join pages in Library.
4. **Code Mode:** Dynamic Workers running a program over Atlas's own tools, with the same kinds and approvals as a direct call.
5. **The browser:** Browser Run with the live view on the stage and take over. Anything it submits or buys is an outside or irreversible action, so it goes through approvals.
6. **The vault:** built-in first (1Password and Bitwarden later), filled into a browser page, a sandbox request or an API header, never into the model's context. Register each value with the scrubber (`core/src/outbox.ts`) so a later page read can't echo it.
7. **Skills and learning:** the index in context, drafting after an accepted task, the "I learned…" receipt, and the Skills page.
8. **Finding a way, and the rest of the views:** compare, the custom kit, small apps and MCP Apps.

Keep the invariants: one loop, one log, one clock, one way out. A search query, a fetch, a sandbox's network request and a browser's submit all leave Atlas, so each one goes through the outbox's checks and leaves a receipt. A new mechanism replaces an old one or doesn't go in.

## 5. Where to put things

[HANDOFF-M1.md §5](HANDOFF-M1.md#5-where-to-put-things) and [HANDOFF-M2.md §5](HANDOFF-M2.md#5-where-to-put-things) still hold. M2 added:

| To add | Do this |
|---|---|
| A stage view | Its zod contract in `core/src/stage.ts` (add it to `StageView`); name-to-id resolving in `resolve` in `core/src/tools/show.ts`; its live page in `stagePage` (`core/src/agent/views.ts`) if it points at what Atlas knows; the view in `app/src/StageViews.tsx` (`ViewBody`, `KIND`, and `StageCard`'s preview). Pages can hold it with no more work. |
| A tool | Give it a kind (`look`, `change_own`, `outside`, `irreversible`): the kind decides whether Atlas asks (`ASKS` in `core/src/approvals.ts`). An outside or irreversible tool never acts itself: it hands an `Action` to `ctx.exit`. Add it to the tool sets in `core/src/agent.ts`: the owner's, automations' (`AUTOMATION_TOOLS`) and test runs' (`TEST_TOOLS`, look-only). |
| Something that leaves Atlas | Through `Outbox` in `core/src/outbox.ts`: `deliver` for messages, `perform` for actions, with a `delivery` receipt that keeps the status, host and the service's own words. |
| An automation trigger or step | `Trigger` or `Step` in `core/src/automations.ts`, its words in `whenText` or `stepText`, its run in `AutomationDesk` (`core/src/agent/automations.ts`), and the form in `app/src/pages/Automations.tsx`. A trigger that looks before it runs goes in `look`, with a quiet row when nothing happened. |
| A setup step | `SETUP_STEPS` in `core/src/agent/setup.ts`, the step enum in `core/src/protocol.ts`, and `STEPS` in `app/src/Setup.tsx`. A new step reopens setup once for owners who finished it. |
| A setting the owner changes | A field in `Settings` (`core/src/store/settings.ts`) with a default, so older stored settings read safely, and its place in the app (rule 5). |
| Something made once per deployment | On start, guarded by a key in `core/src/store/state.ts`, as `seedRoutines` does (`core/src/routines.ts`). |
| A log kind | `LogKind` in `core/src/store/log.ts`, its line in History (`app/src/pages/History.tsx`), and its filters in `KINDS` (`core/src/agent/views.ts`). |

## 6. A first draft of M3's smoke test

Finish this from the final M3 scope before building.

**The web**
- [ ] "Find cheap lunch places within five minutes of UCF." Atlas searches, answers with a pick and why, and a research view on the stage lists its sources. Keep saves it as a page.
- [ ] "What does this say?" with a link: Atlas reads the page and answers, with the link as its source.
- [ ] A question that would put private details into a search ("search for my landlord's address") is stopped by the public-query check, and Atlas says what it searched instead, or why it didn't.
- [ ] By voice, a search starts with a status line within a second, and the answer is short.

**The workspace and files**
- [ ] "Make a spreadsheet of my reminders this month." A file appears in Library beside pages, opens on the stage, and downloads.
- [ ] The first time the sandbox reaches a new website, Atlas asks once; after that, that site just works.
- [ ] The app shows the sandbox's terminal and files live while it works.

**The browser and the vault**
- [ ] "Check the price of the camera on that shop's site." The live browser shows on the stage; Take over hands it to the owner for a login, and back.
- [ ] Save a login in the vault by name. Atlas fills it on its own site and nowhere else, the first use there asks, the model never sees the value, and History shows each use.

**Code Mode, skills and finding a way**
- [ ] A task that needs many lookups runs as one program, with its receipts, faster than step by step.
- [ ] After a task the owner accepts, a receipt says "I learned how…", the Skills page shows the skill, and the next time Atlas uses it.
- [ ] When Atlas is truly stuck, it sends one message: what it tried, and the one thing it needs.

**Regression**
- [ ] M2's carried steps: the calendar trigger (20), the routines' calendar part (39), push on each device (33), and webhooks from Cloudflare (26).
- [ ] M2's smoke test, then M1's, then M0's.
