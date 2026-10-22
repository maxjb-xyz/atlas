# Handoff: M3 closed, M4 next

**Date:** 2026-10-22. **From:** the M3 build. **For:** whoever builds M4, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M3.md](M3.md) first. This page covers what M3 left behind: where things stand, what we learned, what's still open, and a suggested order for M4.

## 1. Where things stand

- **M3 is closed** by the owner, with steps not yet run on the deployment ([M3.md §7](M3.md#7-carried-into-m4)). They join M4's smoke test as regression (§6), with M2's carried steps. The calendar still waits.
- **The deployment** is the owner's own Cloudflare account at a workers.dev address, on Workers Paid, with R2 turned on (the files bucket is `atlas-files`) and the `Workspace` container application. The owner deploys; the build sandbox has no Cloudflare, OpenAI, Apple or ElevenLabs accounts.
- **The code** is on branch `claude/zealous-goodall-5lmvdq` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M4.
- **The checks** are `npm run check`: typecheck, 239 tests in the Workers runtime, and the app build. All pass.
- **The size** is about 18,800 lines of core runtime against the 25k budget (rule 4), plus about 9,900 in the app. M3 spent about 5,300; M4 to M7 share the last 6,000, so M4 should replace before it adds where it can (§4).
- **Working today**, on top of M2:
  - the web: search (Cloudflare Web Search, or Tavily, Brave or Exa by key) and reading pages, with the public-query check, receipts, and the stricter exit after a run reads the web;
  - the browser (Browser Run behind five narrow tools, live on the stage, Take over), the vault (logins, cards, keys, two-factor codes; filled at the last step, never seen by the model);
  - files in R2 beside pages in Library, and the file, document and code views;
  - the workspace: a container per person behind a gate that allows websites one yes at a time, a terminal, preview links, /workspace kept in R2, a setup snapshot, and Restart;
  - Code Mode (one program over Atlas's tools in a Dynamic Worker), skills (SKILL.md, versions, weekly checks), and finding a way in the character;
  - MCP servers (sign-in or token; tools found with `mcp_tools`, used with `mcp_call`, asking by kind) and MCP Apps on the stage;
  - the chart, compare, kit and app views; helpers working in the background; a busy edge and Stop on the chat box; the stage kept across pages, one tab per thing shown.

## 2. What M3 taught us

M0 to M2's lessons still hold: make every failure explain itself, research before guessing, keep fakes as strict as the real runtime, test against data the last version saved, and drive the UI in a browser before calling it done. M3 added these:

- **Run first starts from nothing.** The workspace's missing certificate bundle only showed on the deployment: every local run after a reorder started from a snapshot that already had the package. Before calling a start-up path done, run it with a fresh state folder (`wrangler dev --persist-to <empty dir>`) and no snapshot.
- **Running isn't ready.** A failed start left a container running without its packages, and later commands trusted it. Mark the end of a multi-step start explicitly (the workspace writes `/etc/atlas-ready`), and clean up on failure.
- **Read what goes out to third parties.** The Agents SDK signed in to MCP servers as `owner` (its agent id). Defaults in libraries end up on other people's screens; check them.
- **Not every service supports the standard path.** GitHub's MCP server has no dynamic client registration, so it takes a token. Make the error say what to do instead, and don't leave half-added state behind.
- **Wrangler can fail quietly into a worse error.** When it can't list R2 buckets (a 403, R2 not turned on), it skips provisioning and tries to inherit a binding that never existed. Name resources in the config, and put "turn the product on first" in the deploy notes.
- **One line means a long wait blocks the owner.** Runs go one at a time, so a turn waiting on a helper made "how's it going?" sit on Thinking. Prefer background work, short waits, and state in the context (helpers at work) over waiting.
- **Every yes should carry on.** A yes in the app to one kind of action resumed the task and another didn't. Rules like this belong in one place, for every kind.
- **UI state outlives a page.** Stage views lived in Home's state and vanished on navigation; tabs went by receipt, so the same workspace opened many tabs. Keep what the owner arranged, and give views of one thing one identity.
- **Check protocols against the other side's real code.** MCP Apps were checked with the official ext-apps SDK's `App` against a real MCP server, which is how the host was trusted.
- **Local checks need the real pieces.** Containers in `wrangler dev` need Docker running (`dockerd`), or `--enable-containers=false` when the check doesn't touch the workspace. Docker Hub rate-limits pulls (429), so reuse cached images. The scripted brain for browser checks is still a local patch to `#makeBrain`, switched on from `.dev.vars`, never committed; a step that sleeps until stopped helps check anything that shows while a turn runs.

## 3. Open issues carried into M4

### 3.1 The calendar

Still waiting, and M4 needs it more than M3 did: the situation's "what's next, and when to leave" (VISION §10.2) and the rhythm moments around meetings both read the calendar. Settle it first in M4 ([HANDOFF-M2.md §3.1](HANDOFF-M2.md#31-icloud-refuses-atlass-sign-in) has the decisive test and the three ways out: public calendar links, a relay on the owner's Mac (which M4's desktop node could be), or Google Calendar).

### 3.2 Not yet checked on the deployment

Everything in [M3.md §7](M3.md#7-carried-into-m4): above all the browser and the vault (no Browser Run session has run for real), an MCP server's sign-in coming back connected, Code Mode and skills, MCP Apps, and Stop. From M2: push on each device (iPhone especially) and webhooks from Cloudflare.

### 3.3 Voice latency (an M0 exit check that still isn't met)

Unchanged since [HANDOFF-M3.md §3.3](HANDOFF-M3.md#33-voice-latency-an-m0-exit-check-that-still-isnt-met). M4 makes it matter more: "in your ear" nudges (§10.3) and the situation in every prompt both press on the voice path. Run the benchmark sweep and pick the voice brain from data.

### 3.4 Smaller items

- **MCP:** a server without dynamic client registration needs a token (no pre-registered OAuth client yet); MCP Apps run in one sandboxed frame, so a page gets no storage of its own; `ui/message` and model context from a page aren't offered.
- **The workspace:** a preview whose server uses absolute paths won't find its files; /workspace over 200 MB isn't kept; containers on the Durable Object scheduling policy are a public beta.
- **Skills** that bring their own scripts (a folder) aren't supported, only the SKILL.md.
- **Extensions** (VISION §17) wait for their own milestone.
- **The vault:** 1Password and Bitwarden come later. Cards always ask with a hold, but the card doesn't show an amount yet: the money kind from [HANDOFF-M3.md §3.4](HANDOFF-M3.md#34-smaller-items) is still to do.
- **Stop** ends the owner's text turns; Atlas's own runs show the busy edge but can't be stopped from the chat box.
- **Images from the owner** (a photo in the chat) aren't read yet. Messaging channels (M5) will need them, and VISION §16.1 now wants rich content in those threads ([M3.md §6](M3.md#6-decided-with-the-owner), item 6).
- **Tests:** the setup test failed once in a full run, and one other full run failed once without its output kept. Neither reproduced. If one comes back, keep the output.
- **From M2 and M1, still open:** export (VISION §23.4), per-area autonomy, the fixed interruption budget, suggestions matched by words, Markdown headings, a resumed helper logging its cut-off step twice, History's "Show earlier" starting over, ChatGPT sign-in ending with a paste, and benchmark turns landing in the real thread.

## 4. M4: senses

From VISION §25, M4 proves **the gym-to-store moment, and others like it**: Atlas notices what's happening and speaks up when it matters, and only then. It adds:

- **senses** (§10.1): location first (OwnTracks, then the phone), and the events nodes send;
- **nodes** (§16.3): a device that dials out to Atlas, pairs once with a QR code, announces its tools and event sources, and is offered only while it's online and allowed; the phone and the desktop first; sensitive capabilities start off;
- **the situation** (§10.2): a small live record always in context (where you are and since when, what you're doing, what's next and when to leave, travel time, weather that matters, device states), rebuilt from events, never guessed;
- **decide-then-wake awareness** (§10.3): rules, then the `decide` role (Clef), then Atlas only when it matters; rhythm moments that may end in silence; reactions to nudges logged;
- **location-based errands:** an errand matched to where you are and your route;
- **M4's stage views** (§21.6): situation, map, place and weather, and Now and day rebuilt from the situation.

### Suggested order

1. **Groundwork:**
   - merge M3;
   - settle the calendar (§3.1);
   - choose with the owner: the location source (OwnTracks over HTTP to start; a web app can't send location in the background), the maps and routing provider (travel time and "off your way home" need routing; map tiles for the views), and weather (Open-Meteo needs no key). Each is a third party, so each query goes through the outbox's public-query check (VISION §4.4: private details never go into a map query): a saved address can only go to a routing service the owner chose;
   - decide what the first node is: the desktop app (Tauri, VISION §21.10) or a small node first, to settle the protocol;
   - write M4's smoke test (`docs/M4.md`) from the draft in §6.
2. **Location as a sense:** OwnTracks posts to a Worker route with its own token; each fix is an event in the log (sparse: arrivals, departures, and a fix only when it moved), with places from Library matched by region. Settings → Devices shows the last fix and turns it off.
3. **The situation:** one record per person, rebuilt from the latest events on the one clock, in every prompt's fresh part (beside focus and reminders in `core/src/context.ts`). The calendar and weather feed it.
4. **Decide-then-wake:** every event through rules, then `decide` (the `#decider` the areas tagger already uses), then a run of Atlas's own only when it matters, ending in a nudge or silence. Reactions to each kind of nudge are logged. Rhythm moments are agenda items on the clock.
5. **Errands:** an errand is an agenda item with a place or a kind of place; a departure or a route matches it. The gym-to-store moment is the test.
6. **Nodes:** the protocol (pairing by QR, an outgoing WebSocket to the person agent, capabilities announced as tools and event sources, offline handling), then the first node. Offer a node's tools only while it's online and allowed; "Your Mac's asleep. I'll do it when it wakes."
7. **The views:** situation, map, place and weather, and Now rebuilt from the situation.

Keep the invariants: one loop, one log, one clock, one way out. A sense puts events in the log; awareness is the clock and `decide`, not a second loop; a nudge leaves through the outbox like every message.

## 5. Where to put things

[HANDOFF-M3.md §5](HANDOFF-M3.md#5-where-to-put-things) still holds. M3 added:

| To add | Do this |
|---|---|
| Something that reaches a third party | Through the outbox (`core/src/outbox.ts`): `look` for reads that leave (secrets scrubber and public-query check first), `perform` for actions, `mcp` for a connected server's tool. Each leaves a `delivery` row with its channel, status, host and the service's own words. A channel whose answer is someone else's words joins `#readTheWeb` in `core/src/agent.ts`. |
| An approval kind | The `Action` in `core/src/approvals.ts` (with `kindOf`, `trustKey`, `titleOf`), its card step in `stepView` (`core/src/agent/views.ts`) and `ApprovalStep` (`core/src/protocol.ts`), its label in `app/src/Approval.tsx`, and what it does in `Outbox.perform`. A yes in the app carries the task on by itself. |
| A stage view of one thing | As in M3's table, plus its identity in `identity` in `app/src/pages/Home.tsx`, so showing it again reuses its tab. Composed views (charts and the like) go in `app/src/ChartViews.tsx`. |
| A test seam | A field in `seams` (`core/src/agent/seams.ts`): `undefined` uses the real thing, `null` means none, a fake for tests. There are seams for the browser, the workspace, MCP and web search. |
| A package in the workspace | `PACKAGES` in `core/src/workspace.ts`. Changing it changes `BASE`, which makes a new setup snapshot on the next start. |
| A helper's report finishing more | The tools passed to `#atlasSays` in `#reportJob` (`core/src/agent.ts`). |
| Something kept per person | A `StateName` in `core/src/store/state.ts`, with a line saying what it holds. |
| A connected-server feature | `core/src/mcp.ts` (the client interface, results in words, MCP Apps' policy), the tools in `core/src/tools/mcp.ts`, and the host in `app/src/McpApp.tsx`. |

## 6. A first draft of M4's smoke test

Finish this from the final M4 scope, and the owner's choices in §4, before building.

**Location and the situation**
- [ ] Set up OwnTracks with Atlas's address and token. Settings → Devices shows the last place and time; arriving at and leaving a saved place each show once in History, not every fix.
- [ ] "Where am I and what's next?" answers from the situation (place, since when, the next thing and when to leave), without a lookup it doesn't need.
- [ ] Home's Now is rebuilt from the situation: where you are, what's next with leave-by, and weather only when it matters.
- [ ] Turning location off stops it at once, and Atlas says it doesn't know where you are rather than guessing.

**Awareness**
- [ ] "I need oat milk." Leaving the gym, a nudge arrives within a minute: a store a couple of minutes off the way home, and whether you still need it. Ignoring it, replying "stop" and replying "thanks" are each logged.
- [ ] Events that don't matter end quietly: History shows they were decided not relevant, cheaply, and nothing woke the main brain.
- [ ] A rhythm moment (start of day) either says something useful or stays silent, and says nothing twice.
- [ ] A meeting with travel: the nudge to leave comes with time to spare, from real travel time.

**Nodes**
- [ ] Pair the first node with a QR code. It shows in Settings → Devices with its capabilities, sensitive ones off.
- [ ] Atlas uses one of its tools while it's online. With it offline, Atlas says so and does it when it's back.

**The views**
- [ ] "Show me where the dentist is" puts a map on the stage, and a place view with its details and visits.
- [ ] "Do I need an umbrella this afternoon?" answers from the weather in the situation.

**Regression**
- [ ] M3's carried steps ([M3.md §7](M3.md#7-carried-into-m4)), M2's carried steps (the calendar trigger, the routines' calendar part, push on each device, webhooks from Cloudflare).
- [ ] M3's smoke test, then M2's, M1's and M0's (their calendar steps once the calendar is connected).
