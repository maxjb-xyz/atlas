# Handoff: M5 closed, M6 next

**Date:** 2026-10-23. **From:** the M5 build. **For:** whoever builds M6, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M5.md](M5.md) first. This page covers what M5 left behind: where things stand, what we learned, what's still open, and a suggested order for M6.

## 1. Where things stand

- **M5 is closed** by the owner, with steps not yet run on the deployment carried into M6 ([M5.md §5b](M5.md#5b-carried-into-m6)): everything that needs Gmail, Atlas's own email address, Telegram, or GitHub's and Linear's tokens, plus step 8 again after the next deploy.
- **The deployment** is the owner's Cloudflare account at a workers.dev address, deployed by hand (pushing doesn't deploy). It runs M5 up to the fix for Workers AI's tool list; the fix for `extract`'s list field (commit after `389f709`) and the fix for approvals (below) need one more deploy.
- **The code** is on branch `claude/friendly-einstein-sf3syv` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M6.
- **The checks** are `npm run check`: bundling the extensions, typecheck, 326 tests in the Workers runtime, and the app build. All pass.
- **The size** (rule 4) is about 28,800 lines of core runtime, up from 24,600 at M4's close, plus 3,500 lines of bundled extensions outside the core and 12,400 in the app. What grew: the agent (members, faces, chats, mail), the extension mechanism (about 1,100), contacts and loops (550), faces (500), Atlas's own address (450), channels (200), and the mail and people tools (450). What M5 moved out rather than added beside: every M4 provider tied to one service (iCloud, OwnTracks, OpenStreetMap, Mapbox, Open-Meteo, Tavily, Brave, Exa, GitHub's and Linear's webhook parsing), now bundled extensions.
- **Working today**, on top of M4:
  - the core and its extensions (VISION §17): a manifest, a Dynamic Worker sandbox whose only way out is the core's gate (hosts allow-listed, secrets filled at the gate by a nonce only the sandbox knows), sign-ins the core runs, cursors, one look on the clock, an address for posts, drafts Atlas writes, Settings → Extensions;
  - contacts from iCloud or a vCard file, with channels and trust; `person`, `contact_save`; new senders become people;
  - `extract` with Workers AI's Clairic, facts shown on the item; `calendar_move` with Undo;
  - Gmail as a sense and mail out as the owner; Atlas's own address across Cloudflare accounts, sending by Cloudflare or Resend;
  - open loops; GitHub's and Linear's notifications by token;
  - Telegram as the owner's chat (voice notes, photos, approvals as buttons) and as a face's address;
  - faces with their stranger test, Inbox handoffs and a daily digest;
  - members with their own passkey and Atlas, and shared areas;
  - `area_look` for digests.

## 2. What M5 taught us

M0 to M4's lessons still hold. M5 added these:

- **Draw the core's line early, and hold it.** The owner's question "you aren't building GitHub as core logic, are you?" reshaped the milestone. The rule that came out of it (the core is Atlas's mechanisms, the Cloudflare platform and open standards; everything tied to one service is an extension) made every later service a plug-in, not a branch in the core.
- **A model provider's schema rules are part of the contract.** One tuple in one view's schema made Workers AI refuse the whole tool list, so the fallback brain had been broken without anyone seeing it. Test the tool list against each provider's rules, not just one.
- **Check the provider's real types before calling a model.** `extract` asked Clairic for a field type it doesn't have, and failed on every call without a trace. Read the model's docs page, and keep failures on the item, so the first real run says what's wrong.
- **Quiet failures cost a round trip.** `extract`'s error only reached the Worker log; the fix was to keep it where the owner and the next agent look (the item, History).
- **Anything a stranger can write is an input to every layer.** The reviews found a secret placeholder a stranger could make the gate fill, a spoofed sender taken as the owner, a Message-ID that could add a Bcc, and a forwarded message read as the owner's words. Three reviews of the whole change, each by area, found all of them; run them before the smoke test, not after.
- **A member's Atlas is a second Atlas, not a view of the first.** Anything that holds an address or a sign-in (extensions, chats, the workspace) belongs to one agent; M5 keeps those in the owner's and says so.
- **An agent with the setup code runs most of a smoke test,** including members (a software passkey against the real deployment). What it can't do is anything that needs the owner's own accounts: Google, a bot token, a Cloudflare token.
- **Every yes on a card carries the work on, wherever the card is.** A yes from a chat's button didn't resume the task that asked, so Atlas stopped after doing the thing it waited for. Now only a yes said inside a run (by voice or in text) skips the carry-on; any other surface, including a future channel's buttons, resumes it, and a task asked on a chat answers in that chat.
- **Workers AI's Kimi can say "done" without calling the tool.** Once, on a member's Atlas. The fix belongs in the character or the tool's description (rule 1).

## 3. Open issues carried into M6

### 3.1 Not yet checked on the deployment

Everything in [M5.md §5b](M5.md#5b-carried-into-m6), and [M4.md §7](M4.md#7-carried-into-m5): OwnTracks on the real phone, the Mac build, events with a place or people, and the regression lists.

### 3.2 Voice latency (an M0 exit check that still isn't met)

Unchanged since [HANDOFF-M4.md §3.3](HANDOFF-M4.md#33-voice-latency-an-m0-exit-check-that-still-isnt-met). Brains and voice are still in the core (M5.md §6, decision 6) until the sandbox's extra step is measured against voice time.

### 3.3 Smaller items

- **From M5's open questions** ([M5.md §8](M5.md#8-open-questions)): Gmail's push instead of a look; stage views as images in a chat; moving one occurrence of a repeating event; a member's own passkeys in their Settings.
- **Members** have no extensions, Atlas's email, chats, faces or workspace of their own in M5; their posts and sign-ins would need the agent in the address (`/x/<agent>/<id>/<key>`) and a workspace per person.
- **The owner's own card** in iCloud (with their Gmail address) is a separate person until Gmail is connected; Library → People can join them.
- **Decide on home server events:** "plex is down" scored just under "worth knowing later". Watch it once a real extension posts.
- **Places, memory and the rest** from [HANDOFF-M5.md §3.3](HANDOFF-M5.md#33-smaller-items) that M5 didn't touch: opening hours in `place_find`, the "Updated" receipt for a `remember` that changed nothing.

## 4. M6: delegation

From VISION §25, M6 proves **it runs your projects while you're away**: coding jobs through ACP, Atlas as the middleman (VISION §8.2), and long research jobs.

### Suggested order

1. **Groundwork:** merge M5; run M5's carried steps with the owner (Gmail, Atlas's email, Telegram, tokens) and fix what they find; write M6's smoke test (`docs/M6.md`) from the draft in §6, with the owner's choices: which coding agents first (Codex on the ChatGPT plan is the cheapest start), where jobs run first (the workspace container, or the Mac node), and where repos come from.
2. **ACP in the core:** ACP is an open standard, so the client is core; each coding agent (Codex, Claude Code, OpenCode, Gemini CLI) is an extension-like choice of what runs inside the session, with its own sign-in or key. Run the agent in the workspace container (it already has a shell, a sandboxed network with an allow-list, and the vault's keys at the edge) or on a node.
3. **A job is a helper** (VISION §8.1, `core/src/helper.ts`): durable, its own budget, its rows in the one log, its result to Inbox. Don't add a second kind of background work; the coding job is a helper whose tool is the ACP session.
4. **The middleman:** Atlas watches the session's stream, answers routine questions from what it knows (records, the project's area, preferences), and brings the owner only real decisions, as an approval or an Inbox question, through the outbox. "How's the Keyframes job?" answers from the job's state, by voice too.
5. **Review and the PR:** the diff and the tests on the stage (the code and workspace views exist), then a pull request through the GitHub extension (it needs a write scope and an `open_pr` call), with a receipt.
6. **Long research jobs:** a helper that reads and compares for hours, survives restarts (the Agents SDK's fibers), reports progress in Agenda, and lands a research view and a page.
7. **Faces and channels carry over:** a job's question can reach the owner on Telegram, with buttons.

Keep the invariants: one loop, one log, one clock, one way out, one intake. Nothing tied to one service in the core.

## 5. Where to put things

[HANDOFF-M5.md §5](HANDOFF-M5.md#5-where-to-put-things) still holds. M5 added:

| To add | Do this |
|---|---|
| A service (a mail provider, a chat, a sense, a calendar, maps, search) | An extension: `extensions/<id>/index.ts` against `extensions/sdk.ts`, with a manifest naming its hosts and secrets. Add it to `EXTENSIONS` in `core/test/helpers.ts` for tests. The core picks a provider with `pick` in `core/src/providers.ts`. |
| Something an extension needs from the core | A field on `Ctx` or a method on `Extension` in `extensions/sdk.ts`, and its handling in `ExtensionHost` (`core/src/extensions.ts`) or `ExtensionDesk` (`core/src/agent/extensions.ts`). Never a service name in the core. |
| A new outside action | An `Action` kind in `core/src/approvals.ts` (its kind, trust key and title), done in `Outbox.perform` (`core/src/outbox.ts`), shown by `stepView` in `core/src/agent/views.ts` and `app/src/Approval.tsx`. |
| A chat channel | An extension that provides `channel` (receive into `Message`s, `send` from `Out`); `ChannelDesk` (`core/src/agent/channels.ts`) does linking, owner turns and faces. |
| Something a face can do | A tool in `core/src/tools/faces.ts`, listed by `faceTools` from the face's settings (`core/src/face-shape.ts`), and words for it in `facePrompt` (`core/src/faces.ts`). |
| Something a member's Atlas reaches in the owner's | An `api…` method on `PersonAgent` that takes the member's id, called through `#ownerAgent()`; never a socket message. |
| Facts from someone's words | A field in `MESSAGE_FIELDS` (`core/src/brains/extract.ts`), in Clairic's types only (`text`, `number`, `date`, `list` with `items`). |

## 6. A first draft of M6's smoke test

Finish this from the final M6 scope, and the owner's choices in §4, before building.

**Coding jobs**
- [ ] "Fix the failing test in my budget app" starts a job with the agent the owner picked, in the workspace, on a branch. Agenda shows it; the live terminal opens in the app.
- [ ] A routine question from the agent ("which test runner?") is answered by Atlas without the owner; a real decision ("drop the old API or keep both?") reaches the owner as one question, in the app or on Telegram.
- [ ] When it's done, Atlas reviews the diff and the tests, opens a pull request, and the receipt links to it.
- [ ] "How's the budget app job?" by voice answers from the job's state.
- [ ] The job survives a deploy mid-run.

**Research**
- [ ] "Research the best way to do X; take your time" runs for a long while, reports progress, and lands a research view and a page with sources.

**Regression**
- [ ] M5's carried steps ([M5.md §5b](M5.md#5b-carried-into-m6)), M4's ([M4.md §7](M4.md#7-carried-into-m5)), then M5's smoke test and the earlier lists.
