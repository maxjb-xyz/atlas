# Why Atlas feels stiff: the audit of 2026-10-26

The owner's question: why does Atlas still feel stiff and unintuitive, to the point they wouldn't use it today? This is what was found on the real deployment (commit `b2ae15a`), what changed on branch `claude/compassionate-clarke-a72ell`, and what's left for the owner to decide.

## How it was checked

- Every place, on a desktop (1440x900) and a phone (390x844), signed in to the deployment.
- Real conversation, timed from the WebSocket: when the first status, the first word and the reply arrived, which tools ran, and the tokens each turn sent.
- The whole conversation so far, read reply by reply.
- The exact prompt a turn gets, printed from the test harness.
- How comparable assistants (Hermes, OpenClaw, Poke, ChatGPT, Claude) are built and what their users praise, with sources.

## What was found

### 1. The character is a rulebook, and the model obeys it literally

`core/src/character.ts` was about 1,800 words, nearly all "you never", "you don't" and "only when". Its history shows why: 19 commits, most of them a new sentence after an eval run found a miss. That's VISION §2's cause 1 (40 personality patches around the model) again, written in prose instead of code. The model followed every rule at once:

- **It hedges.** "I can't audition them myself, so these are based on the track listings." "I don't have your location, so treat that as a rough local-area forecast." "Your location's unknown, so I can't tailor it."
- **It recites.** "hey" got "Hey, boss. Nothing else is on your calendar today." Another "hey" got the video files and the French homework.
- **It answers from a template.** Five day questions in a row ended "The rest looks clear."
- **It has no humor**, with Humor set to 5 of 5, and "Who are you?" got a help desk answer ("I'm here to help with the practical stuff and the fun stuff").

The eval reinforced this. Its yardstick listed only what breaks character, so each run could only add another "don't", and nothing ever measured whether Atlas sounded like a person.

### 2. The per-turn context is instructions dressed as facts

Every turn carried lines like "Where: unknown. No location has come in yet (OwnTracks isn't set up, or hasn't reported); say so rather than guess." That one sentence is the direct source of the location hedging. "Next: nothing more on the calendar today" is where "Nothing else is on your calendar today" came from. Lines like "The owner has no webhooks" and a paragraph of speaking-up rules ("Never say you changed how you'll speak up...") rode along with every "hey". Research on context agrees: irrelevant but related lines distract models most, and whatever's in the context gets mentioned.

### 3. It's slow because answers take several trips to the brain

Measured on the deployment (ChatGPT, `gpt-6-luna`, low effort):

| Message | First word | Done | Model calls |
|---|---|---|---|
| "morning! anything I should know about today?" | 6.1 s | 7.5 s | 3 (calendar, weather, answer) |
| "remind me to buy groceries tomorrow after class" | 6.2 s | 7.2 s | 3 (calendar, reminder, answer) |
| "what did I tell you about Lisbon?" | 4.7 s | 5.9 s | 2 (recall, answer) |

Each trip is about 1.5 to 2.5 s, and the turn's tokens add up to 26k to 39k across them (about 13k a call: 2.2k character, 7k of tool schemas, the rest history and context). The calendar was a lookup every time, because the situation only kept today and tomorrow and the character said never to state a calendar fact "you haven't looked up in this conversation". The people who study this put the bar for text at under a second to the first word; Poke and ChatGPT feel fast because small talk never waits behind lookups.

### 4. The pages read like an ops console

- Mono uppercase labels everywhere: "APPEND-ONLY · KEPT FOREVER", "EVERY RECORD KEEPS ITS SOURCE", "LIVE · UPDATED NOW", "0 RUNS TODAY · 0 FAILED", "1 STEP · 0 POWERS", "TOKENS 169.4k".
- History was mostly Atlas's own upkeep: "Reminder done: Look back for skills" about eight times a day, "Look for a newer services index", "Coming up at 11:55 PM: set aside by a rule (...) · 0.00 s", "Showing · Wed, Oct 28".
- The Morning brief card showed its instructions to Atlas as its description ("Atlas: Look at the owner's day ahead...").
- Contacts: 221 people, all "Unknown", with five filters at 0 and junk from the address book ("Abby Computer Facetime", "Affirm Verification").
- Receipts said "13:45" while Atlas said "1:45 PM"; schedules said "08:00".

### 5. The phone, where it's used most, looked unfinished

The More menu and the area switcher rendered as centered columns of underlined links (a generic `.item` rule). The Jobs list ran off the left edge. Home's Now and Week pills floated over the first message. Tap targets were 18 to 30px. The composer covered each page's last rows, and its 15px text made iOS zoom on focus. A time sat under every message, so the thread read like a log. On a desktop, the sidebar animated between 58 and 220px on every trip to or from Home, sliding the whole page.

### 6. Smaller bugs found on the way

- A day view drawn in the reply uses the browser's time zone, not the owner's: in a UTC browser, a 10:30 class drew at 2:30 PM. Fine while the owner's browser is in their zone; wrong when travelling.
- A reminder cancelled from Agenda kept offering Undo on its receipt in the thread.
- The deployment is two commits behind `main` (`b2ae15a`), so check-ins and areas on everything aren't live yet. The app from `main` crashes on Automations against that older server, since it expects the newer `areas` field.

## What changed

**How Atlas talks** (commit "How Atlas talks: ..."):
- `character.ts` is rewritten at about 840 words, as who Atlas is and how it talks, with five sample exchanges for the feel. The rules that still matter stay, in a sentence each. A comment at the top says not to grow it a "never" at a time.
- The context is facts only. Unknown location goes unsaid, "nothing more today" and "no webhooks" are gone, and the speaking-up rules moved into `speaking_up`'s description.
- The situation keeps the calendar 7 days ahead and lists it a line a day ("Their calendar for the next week (already looked up...)"). "What's Thursday like?" is now one trip to the brain instead of two or three.
- The yardstick (`docs/CHARACTER.md` and `YARDSTICK`) gains "Sounds like a person" and a sixth way to break character: padding nobody asked for.

**The app** (commit "The app as a phone app, ..."):
- Every phone bug in section 5 is fixed, and the sidebar keeps one width.
- History leaves out Atlas's upkeep, and at Simple, sense reports, decisions to stay quiet and "Showing" entries.
- Automation cards say what they're for. The plumbing labels are gone. Inbox and Contacts filters show only when someone's in them. Clocks are 12-hour everywhere.
- A cancelled reminder's receipt stops offering Undo.

All checks pass (`npm run check`: 524 tests, typecheck, build).

## What to check after deploying

These changes can't be tried against the real brain before they're deployed. After `npm run deploy`:

1. `npm run eval:jarvis -- --url ...` and `npm run eval:character -- --url ...`, then compare with the last runs.
2. By hand: "hey" gets a hey back with nothing tacked on; "what's Thursday like?" answers in about 2 to 3 s with no "Checking your calendar"; "is it gonna rain" has no line about location; "who are you?" sounds like someone; a joke gets a joke back.
3. If a miss shows up, change a sentence or an example in `character.ts`. Don't add a rule.

## What's left, for the owner to decide

These are bigger than a fix, so they wait for a yes.

1. **A fast brain for chit-chat.** ChatGPT routes small talk to a fast model and saves the reasoning model for hard turns. Atlas could start every owner turn on the voice chain's fast brain and hand over when a tool needs the main one. It stays one loop with a choice at the start. Expected: first word under a second for "hey", "thanks" and "lol".
2. **Fewer places.** Eight places plus settings is a lot of app for an assistant whose home is a conversation. One shape: Home, Inbox, Agenda and Library stay; People moves into Library; Automations, Abilities and History go under one "Atlas" place beside settings. Everything stays reachable, and everything stays askable.
3. **The frame on pages.** The dashed rails, corner nodes and mono labels suit views Atlas puts up. On ordinary pages (Contacts, History, Settings) they make the app feel like a design tool. Keep the frame for the stage, and let pages be plain.
4. **Contacts hygiene.** Hide address-book entries that aren't people ("Abby Computer Facetime", "Check Data Verison") and merge duplicates, as a reviewable list, never silently.
5. **Times in the owner's zone** in every view, not the browser's.
6. **Shorter bubbles.** Poke splits replies into a few short messages, which reads like texting. Worth a try once the character settles.

## Sources

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), and the [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): positive framing, a few canonical examples, no laundry list of edge cases.
- Chroma, [Context rot](https://research.trychroma.com/context-rot): related but irrelevant context hurts most.
- OpenAI, [GPT-5.1 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide): contradictory instructions cost newer models more. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- Hermes, [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory): about 1.3k tokens always loaded, hard-capped. OpenClaw, [SOUL template](https://docs.openclaw.ai/reference/templates/SOUL) and [heartbeat](https://docs.openclaw.ai/gateway/heartbeat): a proactive check that finds nothing sends nothing.
- TechCrunch on [why Cognition bought Poke](https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/): personality and timing are what users mention.
- Nielsen Norman Group, [response time limits](https://www.nngroup.com/articles/response-times-3-important-limits/).
