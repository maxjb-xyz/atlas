# Handoff: M4 closed, M5 next

**Date:** 2026-10-23. **From:** the M4 build. **For:** whoever builds M5, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M4.md](M4.md) first. This page covers what M4 left behind: where things stand, what we learned, what's still open, and a suggested order for M5.

## 1. Where things stand

- **M4 is closed** by the owner, with steps not yet run on the deployment ([M4.md §7](M4.md#7-carried-into-m5)): the phone, the Mac, Mapbox, events with a place or people on the calendar, and the regression lists. They join M5's smoke test as regression (§6).
- **The deployment** is the owner's Cloudflare account at a workers.dev address, as in M3, now with OwnTracks posting to `/owntracks` (set up again after the smoke tests, so the owner's phone needs it once more) and iCloud answering for the calendar.
- **The code** is on branch `claude/determined-fermi-lt32ry` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M5.
- **The checks** are `npm run check`: typecheck, 286 tests in the Workers runtime, and the app build. All pass.
- **The size** (rule 4) is about 24,600 lines of core runtime, up from 18,800 at M3's close (about 5,800 more), plus about 11,200 in the app and 700 lines of Rust in the desktop app. What grew: awareness, the later pile and the moments before events (`core/src/agent/senses.ts`, about 950), the intake (650), the situation (480), maps (450), location (420), nodes (360), the place tools (360), tasks (300 with their tools) and weather (190). What M4 replaced rather than added beside: the automations' own calendar polling (the intake's look is the one), the start-of-day and evening looks (the default routines), errands (tasks), and the look before leaving (the moment before each event).
- **Working today**, on top of M3:
  - location from OwnTracks (arrivals, departures, real moves), saved places as its regions, and location off;
  - the situation in every prompt (where, doing, next and who it's with, travel time and leave-by, weather that matters, devices);
  - one intake for every source (location, the calendar, devices, the trip and weather, webhook sources with GitHub's and Linear's signatures), with saved states, repeats, the later pile and its batch look, and the Senses screen;
  - awareness: rules, then `decide` (Clef), then a run of Atlas's own that nudges or stays quiet; reactions to nudges; "why didn't you tell me?" with `noticed`; Always bring up and Don't bring up;
  - tasks with "when it fits" (a kind of place, a place, a person or words), matched by rule for places and people and by `decide` otherwise;
  - the moment before each event, with who it's with and the trip to it;
  - the morning brief and evening wrap-up as routines that report only when something is worth saying;
  - nodes: pairing by the device flow, the desktop app (Tauri) as the first node, calls that wait while it's offline;
  - the map, place, route, weather, situation and senses views.

## 2. What M4 taught us

M0 to M3's lessons still hold. M4 added these:

- **An agent with the owner's key can run most of a smoke test.** Five runs on the deployment, each by a background agent with the setup key in a file it never prints, found nearly every finding in §4 of M4.md. What it can't do is the phone, the Mac, and anything that needs the owner's own data (a calendar invite with a person).
- **Build the goal, not the example.** The first awareness build scripted the gym-to-store case; the owner pushed back ("like Jarvis"). Every item now goes through the same steps, and what to make of it is Atlas's judgment.
- **When a match is a fact, make it a rule.** Clef scored the same departure with the oat milk open anywhere from 0.31 to 0.57 across runs, either side of any bar. Leaving a place with a place task open, and an invite from someone a task is for, are rules now; `decide` is for judgment.
- **Models trust old chat over current state.** Atlas said Always bring up held something it no longer did, because an earlier turn said it was added. Say in the context that what's shown is what's set now.
- **Put an instruction where the data is.** "Put up the weather view" in `show`'s description failed three runs in a row; the next try puts it on the situation's weather line. Check it worked before calling it done.
- **Shared free services may refuse Cloudflare.** All three Overpass servers failed from Workers (522, 524, 504) while Nominatim answered. Time-limit each try, and fall back.
- **An upgrade runs on real data.** The routines upgrade took the evening look's time though that look was off, so the owner's Evening wrap-up moved to 20:00. Test upgrades against the states real deployments are in, including "off".
- **A change by Atlas shouldn't reset what it didn't touch.** Moving the brief from chat paused it, cleared its test, and could drop its report. Tools that change a thing take only what changes. And a fix for saved state doesn't repair what was saved before it: say so, or fix the rows too.
- **Turning a sense off should forget what came from it.** After location off, the weather from the last fix stayed in the situation while the weather tool said there was no location.

## 3. Open issues carried into M5

### 3.1 Not yet checked on the deployment

Everything in [M4.md §7](M4.md#7-carried-into-m5): above all OwnTracks on the real phone, the Mac build, the moment before an event with people or a place, and the regression lists, which haven't run since M3 closed.

### 3.2 Voice latency (an M0 exit check that still isn't met)

Unchanged since [HANDOFF-M4.md §3.3](HANDOFF-M4.md#33-voice-latency-an-m0-exit-check-that-still-isnt-met). Nudges said aloud in a call press on it too.

### 3.3 Smaller items

- **Places:** `place_find` has no opening hours (OpenStreetMap's `opening_hours` tag could give them), so a 2 AM store suggestion rests on Atlas's judgment of the time. The phone's stage tabs cut a long name with no ellipsis.
- **People on events:** the owner's own address shows in "with" lists, since invites list the owner too. Events made on an iPhone usually have no attendees, so they match by title through `decide`.
- **Memory:** `remember` with nothing new still shows an "Updated" receipt.
- **The owner's deployment:** the Evening wrap-up is at 20:00 from the upgrade (it's off); OwnTracks needs setting up again on the phone.
- **Watch on the Brains page:** how often `decide` wakes Atlas on real days, and the batch look's cost.
- **From M3 and before, still open:** everything in [HANDOFF-M4.md §3.4](HANDOFF-M4.md#34-smaller-items), above all images from the owner, which M5's messaging channels need.

## 4. M5: people

From VISION §25, M5 proves **it deals with people for you**. It adds contacts, faces (email, phone, chat), members and shared areas, and digests; and the mail, messages, GitHub and Linear senses, with `extract` and open loops.

### Suggested order

1. **Groundwork:** merge M4; choose with the owner the mail provider (Gmail first, VISION §10.1), the phone provider (VISION §26, open question 5), and which chat channel comes first; write M5's smoke test (`docs/M5.md`) from the draft in §6.
2. **Contacts:** person records with their addresses, numbers and handles, from the owner's contacts and from what comes in. `personKeys` in `core/src/tasks.ts` already matches a person by a name, an address or a handle on their record; contacts should feed it, not sit beside it.
3. **`extract`** (VISION §10.4 step 2): words from other people read by a quarantined helper that returns typed facts and links, never instructions. Webhook items today keep the post as raw content and a line from its fields; mail needs the helper.
4. **Adapters** for GitHub and Linear with cursors (VISION §10.4), replacing the webhook sources for those services where they can, and Gmail as the first mail sense. Each turns what it has into the intake's one row; `from` and `people` on the row are what person tasks match.
5. **Open loops:** an item that opens a loop with a time ("no reply from the landlord in 3 days"), raised by the one clock, the way an absence trigger is. Don't add a second timer.
6. **Faces:** email out, then chat and phone, each leaving through the outbox with a receipt and approvals with earned trust.
7. **Members and shared areas,** then **digests** (the later pile and the routines are the place to start: a digest is a look at the day for one area).

Keep the invariants: one loop, one log, one clock, one way out, one intake. A new source is an adapter into the intake, never its own path to Atlas.

## 5. Where to put things

[HANDOFF-M4.md §5](HANDOFF-M4.md#5-where-to-put-things) still holds. M4 added:

| To add | Do this |
|---|---|
| A sense or a source | An adapter that turns what the source has into `SenseItem`s (`core/src/store/log.ts`) and passes them to `SenseDesk.take` (`core/src/agent/senses.ts`). Give each a `key` (repeats count once), a `thread`, and `from` and `people` when it's from or with someone. Its state for the Senses screen comes from `noteSource` in `core/src/intake.ts`. |
| Something an item can matter to | `#openThings` in `core/src/agent/senses.ts`, with the question `decide` is asked about it. A match that's a fact is a rule in `#consider`, beside the place and person rules. |
| A kind of task fit | `Fits` in `core/src/tasks.ts`, its words in `fitsText`, its field in `task_add` (`core/src/tools/tasks.ts`), and how it's matched in `#openThings`. |
| A node capability | The node announces it; the agent offers it as a tool while the node is online (`core/src/nodes.ts`, `core/src/tools/nodes.ts`). A sensitive one starts off; one that acts asks first. |
| Something on the clock for awareness | An agenda item of kind `rhythm` with its `moment`, handled in `SenseDesk.moment`, which should become an intake item rather than wake Atlas itself. |
| A stage view of the world | `core/src/stage.ts` for its page, `app/src/SenseViews.tsx` for the view. |

## 6. A first draft of M5's smoke test

Finish this from the final M5 scope, and the owner's choices in §4, before building.

**People**
- [ ] "Who's Doug?" answers from his contact: how to reach him, what's open with him, and the last time you were in touch.
- [ ] An email from Doug shows in History as noticed from Doug, and a task for Doug comes up.

**Mail and open loops**
- [ ] Connect Gmail. A newsletter ends as never, a bill as later, and a reply you're waiting for as now; each shows why on the Senses screen.
- [ ] "Tell me if the landlord hasn't replied by Friday." On Friday with no reply, one nudge; with a reply, none.

**Faces**
- [ ] "Email Doug that I'll be late" drafts, asks, and sends from your address, with a receipt; a reply comes back into the thread.

**GitHub and Linear**
- [ ] A review requested on your PR, assigned issues and comments come in through the adapters without a webhook set up by hand, once each after a restart.

**Regression**
- [ ] M4's carried steps ([M4.md §7](M4.md#7-carried-into-m5)), then M4's smoke test, M3's, M2's, M1's and M0's.
