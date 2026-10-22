# Handoff: M1 closed, M2 next

**Date:** 2026-10-22. **From:** the M1 build. **For:** whoever builds M2, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M1.md](M1.md) first. This page covers what M1 left behind: where things stand, what we learned, what's still open, and a suggested order for M2.

## 1. Where things stand

- **M1 is closed** by the owner, with its calendar steps carried forward ([M1.md §4](M1.md#4-found-on-the-real-deployment)). iCloud refuses Atlas's sign-in, so the steps that read the calendar couldn't be run. They join M2's smoke test as regression (§6), along with the character check.
- **The deployment** is the owner's own Cloudflare account at a workers.dev address, on the **Workers free plan**. M0's docs assumed Workers Paid; the difference matters (§3.2). The owner deploys; the build sandbox has no Cloudflare, OpenAI, Apple or ElevenLabs accounts.
- **The code** is on branch `claude/sweet-cori-65oq0q` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M2.
- **The checks** are `npm run check`: typecheck, 142 tests in the Workers runtime, and the app build. All pass.
- **The size** is about 9,500 lines of core runtime against the 25k budget (rule 4), plus about 5,100 in the app.
- **Working today:**
  - text and voice on one socket, with ChatGPT and Workers AI brains and fallback;
  - memory: records written in the turn with chips and undo, and `recall` by keyword, meaning, time and links;
  - compaction, and helpers as sub-agents in durable fibers, with `delegate` and the Jobs view;
  - areas: tagging with Clef, discovery, corrections, scope and tone;
  - the character page and its eval;
  - the UI v1 shell: six places, settings, setup, Graphite and Daylight, phone width;
  - passkeys with revocable sessions, and setup steps 1 to 5.

## 2. What M1 taught us

The M0 lessons still hold: make every failure explain itself, research before guessing, and keep fakes as strict as the real runtime. M1 added these:

- **Test against data the last version saved.** A refusal saved by M0 had no retry time, and the first M1 deploy hung on loading while building Settings from it. When a stored shape changes, read the old shape safely and add a test that seeds it.
- **Know the plan's limits.** Kimi K2.6 is one of eight Workers AI models that need Workers Paid, and the free plan caps Workers AI at 10,000 neurons a day. Check [the pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) before choosing a model or adding background calls.
- **Count what Atlas sends to other services.** M1's pages read the calendar on every view, once per calendar, and each read was a sign-in to iCloud. Keep a copy of anything read often, ask for changes rather than everything, and space retries out.
- **Zod fills defaults inside optional fields.** `Settings.partial()` quietly reset every other setting on a partial update, from M0 on. Patch schemas are built from each field without its default.
- **Drive the UI in a browser before calling it done.** The phone tab bar's More menu was unreachable and Settings lost edits, and both passed typecheck. To check by hand: `wrangler dev --local` in `core/` with a `.dev.vars` holding `ATLAS_OWNER_SECRET` (16 characters or more), Playwright with Chromium, and delete `.dev.vars` afterwards. Brains can't answer locally (Workers AI needs a real account), but every page, setup step and failure path can be checked.

## 3. Open issues carried into M2

### 3.1 iCloud refuses Atlas's sign-in

Fresh app-specific passwords are refused on their first try. The two candidates:

- **Apple is limiting the account** after M1's earlier flood of sign-ins. If so, it clears on its own: Atlas now keeps a copy of the calendar, signs in at most once per check, answers from the copy while refused, and retries after 30 minutes, then 2, 6, 12 and 24 hours ([M1.md §5](M1.md#5-decisions-made-while-building)).
- **Apple refuses Cloudflare's addresses.** No change inside the Worker can get around that.

**How to tell:** Settings → Connections says when Apple refused without asking for the password again, which points at a limit. The decisive test is the owner opening `https://caldav.icloud.com/` in a browser at home and signing in with the app password: if it's accepted there but not from Atlas, it's Cloudflare's addresses. The owner chose to wait a day and revisit.

**If it's Cloudflare's addresses,** the ways out, in the order recommended:
1. **Public calendar links** to get going: no password to refuse, but anyone with a link can read that calendar.
2. **A small relay on the owner's Mac** that reads the calendar from home and passes events to Atlas: VISION §16.3's node, pulled forward for the calendar. This is the lasting fix.
3. **Google Calendar sign-in,** for owners who use Google.

The browser can't call iCloud for Atlas: Apple's CORS only allows `www.icloud.com`.

This matters for M2: calendar-change triggers and a morning brief both need the calendar. Settle it before building those.

### 3.2 The Workers free plan

- **The brain chains still name Kimi K2.6,** which the free plan can't use. The owner should either change it to `@cf/moonshotai/kimi-k2.5` in Settings → Brains (both chains) or move to Workers Paid ($5 a month). Until then, voice tries Kimi K2.6 first about every 10 minutes and falls back to ChatGPT.
- **10,000 neurons a day** cover Clef tagging, embeddings and any Workers AI brain. Past that, tagging and meaning search wait until midnight UTC; replies carry on. M2's automations and watches add background calls, so count them against this.
- **Decide with the owner** whether Atlas targets the free plan. VISION §19.3 says Paid is needed; nothing in M1 needed it, but M2's push notifications and higher call volume may. If Atlas should run on free, the defaults in `core/src/store/settings.ts` and M0's deploy guide need to say so.

### 3.3 Voice latency (an M0 exit check that still isn't met)

At M0's sign-off, a calendar question by voice had its status line at 2.5 s and its answer at 6.6 s, against a target of a status line within 1 s. M1 didn't work on this. [HANDOFF-M1.md §3.1](HANDOFF-M1.md#31-voice-latency-an-m0-exit-check-that-isnt-met) has the levers, in order. Run the benchmark sweep first and pick the voice brain from data, now limited to the models the owner's plan has.

### 3.4 Smaller items

- **The Connections settings page** is laid out for iCloud alone. It needs a design that holds several connections, each with its state, what it found and its own Test, before Google, Microsoft and mail join.
- **A helper resumed after a restart** logs the step it was cut off in again, so Jobs counts it twice.
- **History's "Show earlier"** starts over when new rows arrive.
- **ChatGPT sign-in ends with a paste,** because OpenAI only redirects to `127.0.0.1` (HANDOFF-M1.md §3.3).
- **Benchmark turns land in the real thread.** Bench mode (VISION §23.7) should mark them.

## 4. M2: follow-through

From VISION §25, M2 proves that everything Atlas says it'll do actually happens. It adds:

- **The stage's `show` tool, first** (§21.6, decided 2026-10-22): Atlas puts a view on the stage by filling its typed contract, the same zod schema the app renders from. Start with views from what Atlas already knows: area, person, list and table. Then M2's own views as their features land: draft, approval, plan and automation. Then Keep, which saves a view as a page (§21.7, whose open points need answers first).
- **The agenda** (§4.3): promises and follow-ups become agenda items in the same step Atlas makes them, shown as receipts and in Agenda.
- **Automations** (§13): one object (when, do, allowed to, report), with all five triggers: on request, schedule, event, watch and absence. Steps, instructions or both; a test run that sends nothing; new automations start paused; run history; Atlas suggests them. The Automations page shows each one as a When → Do → Report flow.
- **Approvals with earned trust** (§12): the kind of action decides when Atlas asks, in code. One approval per plan, from Inbox, a receipt, a push notification, voice or a text reply. Hold to confirm for what can't be undone. After several approvals of one kind without changes, Atlas offers to stop asking. Approvals expire and say what didn't happen. The Permissions page shows the whole table.
- **The outbox and notifications** (§4.4, §14): every exit goes through the checks (approvals, the secrets scrubber, sharing rules, the public-query check) and writes a delivery receipt. Urgency, quiet hours, focus, one channel per message, follow-up and an interruption budget. Push notifications to the owner's devices. Settings → Notifications.
- **Default routines:** a morning brief, an evening wrap-up and a weekly review, shipped as automations the owner can edit.
- **Inbox** gains approvals and questions beside M1's finished jobs and failed replies.

### Suggested order

1. **Groundwork:**
   - merge M1;
   - settle the brain chains and the plan with the owner (§3.2);
   - settle the calendar route (§3.1);
   - write M2's smoke test from the draft in §6.
2. **`show` and the first views** (area, person, list, table), so every later feature can put its work on the stage.
3. **The outbox for real:** the exit-check pipeline, delivery receipts, and push notifications to the app. Everything after this sends through it.
4. **Approvals:**
   - the kinds table in code;
   - the approval card as a stage view, and approvals in Inbox;
   - "yes" by voice, hold to confirm, and expiry;
   - earned trust last, once there's a history of approvals to learn from.
5. **The agenda:** promises and follow-ups as agenda items, on the one clock.
6. **Automations:**
   - schedule and on-request triggers first;
   - then event, watch and absence, with `decide` judging watches before Atlas wakes;
   - test runs, paused starts, history, and the Automations page.
7. **Default routines**, once automations and the outbox work.
8. **Keep and pages** last, after §21.7's open points are answered with the owner.

Keep the invariants: an automation, a promise and a watch are agenda items on the one clock (§4.3), and every message, notification and post leaves through the one outbox (§4.4). A new mechanism replaces an old one or doesn't go in.

## 5. Where to put things

[HANDOFF-M1.md §5](HANDOFF-M1.md#5-where-to-put-things) still holds for tools, brain providers, log kinds, settings, tables, app messages and tests. M1 added:

| To add | Do this |
|---|---|
| Something kept between wakes that isn't a setting or a secret | A key in `StateName` in `core/src/store/state.ts`, with a comment saying what it holds. Read older shapes safely. |
| An agenda kind | Add it to `AgendaKind` in `core/src/store/agenda.ts`; wake it through `onAgendaDue` in `agent.ts`. Jobs show how a kind with its own lease works (`core/src/agent/helpers.ts`). |
| A stage view | Its zod contract beside the protocol types, so the agent and the app share it (§19.4); the view in `app/src/`, with compact and expanded states, in both themes and at phone width. |
| Something background work calls often | Keep a copy and ask for changes, as the calendar does (`core/src/calendar/caldav.ts`), and count the calls against the owner's plan. |
| A Workers AI model | Check it isn't paid-only on the owner's plan, and give it a free fallback if it is. |
| Markdown from the model | Show it with `app/src/Markdown.tsx`, which builds React elements, never HTML. |

## 6. A first draft of M2's smoke test

Finish this from the final M2 scope before building.

**Follow-through**
- [ ] "What's going on with Keyframes?" puts the Keyframes area on the stage, and the console has a receipt that opens it.
- [ ] "Remind me to call the landlord if he hasn't replied by Friday." It shows in Agenda as a promise, linked to where it was said, and on Friday it happens (or doesn't, because he replied).
- [ ] "Every weekday at 8, give me a short brief." Atlas fills in an automation you can see and change; it starts paused, a test run shows what it would send, and once on, it arrives at 8.
- [ ] Saying "goodnight" runs an on-request automation's fixed steps, fast, with no model call.
- [ ] A watch on a web page wakes Atlas only when the change matters, and an absence trigger fires when something didn't happen.
- [ ] An automation that fails twice in a row tells you; after several more it pauses itself.

**Approvals**
- [ ] Anything that speaks to someone else waits for your OK, as one card for the whole plan, showing the exact content, who sees it, and the checks it passed.
- [ ] The same approval can be given from Inbox, a push notification, or by saying "yes, send it".
- [ ] Something that can't be undone needs hold to confirm. An approval left waiting expires, and Atlas says what didn't happen.
- [ ] After five approvals of one kind without changes, Atlas offers to stop asking; saying yes stops it, and the Permissions page shows the change and can undo it.

**Notifications**
- [ ] A reminder that fires while the app is closed arrives as a push notification on one device, and reading it there clears it everywhere.
- [ ] Quiet hours hold non-urgent things until they end.

**Default routines**
- [ ] The morning brief, evening wrap-up and weekly review are on the Automations page, editable, and each arrives on time with real content.

**Regression**
- [ ] M1's calendar steps (4, the calendar half of 5, 26, and 28's Week) and step 24 (Check character), carried over from M1.
- [ ] M1's smoke test, then M0's.
