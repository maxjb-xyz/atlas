# Atlas UI v1

Locked on Oct 21, 2026. These screens are the reference for the app shell and the first views. M7 changes some of them (§8): those mockups wait for the owner's OK, and once approved they replace what they change here. [VISION.md §21](../../VISION.md#21-ui) summarizes the decisions; this page has the details and the screenshots.

- **Live canvas:** the "Atlas UI" design canvas, on its Stage page (private to the owner). It is the place to keep iterating: https://claude.ai/artifact/CHgse2xx2xUsf7CgyECBjz
- **Source:** [`source/`](source/) has the eight screens as `.dc.html` files and [`source/builder/`](source/builder/) has the scripts that generate them.
- **Screenshots:** [`screenshots/`](screenshots/), rendered from the source by the canvas's own runtime at 1440×900. Dark is the default theme.

![All eight screens](screenshots/00-overview.png)

---

## 1. What is locked

- **One stage, a console, no side panes.** Each page is one sheet on the stage. Detail opens in place: rows expand, cards open into a flow, Home's stage switches tab. Nothing opens in an inspector on the right.
- **Six places plus settings:** Home, Inbox, Agenda, then Automations, Library, History. Atlas settings sits at the bottom of the sidebar.
- **Areas are not places.** No profiles and no area pages in the sidebar. Areas are a scope switcher in the toolbar, chips on everything, and one table in Library. You can pin an area if you live in it.
- **Background work is a toolbar button**, "2 jobs running", not a sidebar section. Finished work goes to Inbox.
- **You can always just ask.** Every page has the composer at the bottom, with a hint that fits the page.
- **The diamond is Atlas's mark.** It is used as the logo, as the marker for Atlas's own promises and answers, and as the animated ASCII figure on Now and in voice mode. No dots, orbs or glows.

## 2. The shell

```
┌────────────────┬─────────────────────────────────────────────────────────────┐
│ ◆ Atlas        │ [●●●● All areas ▾]           [⠹ 2 jobs running] [Talk] [⌘K] │
│                ├─────────────────────────────────────────────────────────────┤
│ ▢ Home         │ ┊ STAGE / (Now) (Week) (Draft 1) (Jobs 2)        METADATA ┊ │
│ ▢ Inbox     5  │ ┊ ┌─────────────────────────────────────────────────────┐ ┊ │
│ ▢ Agenda       │ ┊ │                                                     │ ┊ │
│                │ ┊ │      the sheet: a week, a draft, a job, a list      │ ┊ │
│ ▢ Automations  │ ┊ │                                                     │ ┊ │
│ ▢ Library      │ ┊ └─────────────────────────────────────────────────────┘ ┊ │
│ ▢ History      │ ┊      ┌─ console (Home) / composer (other pages) ─┐      ┊ │
│ Pinned       + │ ┊      │  last exchange · receipts · type or talk  │      ┊ │
│ Atlas settings │ ┊      └───────────────────────────────────────────┘      ┊ │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

| Part | What it is |
|---|---|
| **Sidebar** (220 px) | The diamond and "Atlas"; the six places with line icons (Inbox shows a count); **Pinned** (areas, people, projects, automations); **Atlas settings** and you at the bottom. |
| **Toolbar** (48 px) | The area scope switcher ("All areas"), the jobs button with a live spinner, **Talk** (Space), **Search** (⌘K). |
| **Stage** | A dotted grid between two dashed rails, with square nodes where the rails cross. A header row says `PAGE /`, then pill tabs, then mono metadata on the right. Below it sits one sheet with square nodes on its corners. |
| **Console** (Home only) | The last exchange, the receipts for what Atlas just did (each with Undo or Review), and the composer with the area chip, the mic and Send. ⌘J opens the full transcript. |
| **Composer** (other pages) | One line with the diamond, a page-specific hint ("Answer, approve, or change any of these"), the mic and Send. |

## 3. The pages

### Home: the stage and the console

| | |
|---|---|
| ![Home, Week](screenshots/01-home-week.png) | ![Home, Now](screenshots/02-home-now.png) |
| ![Home, Draft](screenshots/03-home-draft.png) | ![Home, Jobs](screenshots/04-home-jobs.png) |

- **Now:** the ASCII diamond, a greeting, then Next, Needs you and Jobs, plus the week's load as a bar line.
- **Week:** the calendar. What Atlas just changed carries ember selection handles, a tag ("MOVED · WAS WED 3 PM") and a dashed connector back to where it was.
- **Draft:** something waiting on you, full size, with Edit and Send.
- **Jobs:** one tab per running job, with Steer and Stop. The gear-quotes job shows its helpers as a diagram that converges on the result so far.
- The stage also shows whatever Atlas puts there: a route, a person, a table, a browser.

![Home, coding job](screenshots/05-home-jobs-code.png)

A coding job shows its steps (Plan, Edit, Test, Preview, PR to Inbox) and the harness's terminal. Next to it are the questions Atlas answered on your behalf, each with its source, and a count of how many it asked you (zero here). This is Atlas as the middleman (VISION §8.2).

### Voice

![Voice](screenshots/06-voice.png)

Voice mode keeps the same shell. The stage shows what you're talking about (here the route home, with the Publix stop Atlas added selected). The console becomes a voice strip:
- the animated diamond;
- the sentence being spoken, with the spoken part bright;
- a waveform;
- anything waiting on a yes, answerable by voice or tap;
- latency and the voice model in mono.

### Inbox: everything waiting on you

| | |
|---|---|
| ![Inbox](screenshots/07-inbox.png) | ![Inbox, a purchase](screenshots/08-inbox-spend.png) |

- **The list.** Oldest first, with one item open at a time. Tabs: All, Approvals, Questions, Reviews.
- **Keyboard.** J and K move between items, ⏎ approves, E edits, N means not now.
- **Each item shows:**
  - its kind (Speaks for you, Spends money, Question, Ready for review);
  - its area;
  - who raised it (Atlas, a face, a job);
  - why it needs you;
  - the exact draft, charge or diff.
- **The checks chain.** A row of small tags joined by dashes shows what passed before it reached you, ending at **Your OK**. For a message that's Secrets ✓, Sharing ✓, Facts ✓. For a purchase it's the budget left and the card from the vault, plus a note that Atlas never sees the number.
- **Approving:**
  - Money is **hold to approve**.
  - Merging a PR always asks.
  - Questions are one-tap answers ("Jordan Lee" or "Jordan Park"), and Atlas remembers the answer.
- **Earned trust** shows on every item, for example "Asks every time · 0 of 5 to earn trust".

### Agenda: everything on a clock

| | |
|---|---|
| ![Agenda](screenshots/09-agenda.png) | ![Agenda, Week](screenshots/10-agenda-week.png) |

Agenda shows five kinds of item:

| Kind | What it is |
|---|---|
| **Event** | A calendar event |
| **Reminder** | Something you or Atlas asked to be reminded of |
| **Due** | A deadline Atlas pulled from email |
| **Promise** | Something Atlas said it would do, marked with the diamond |
| **Run** | A scheduled automation run; the automation itself lives in Automations |

- **Upcoming:** a 7-day strip on top (counts and load per day; click a day to filter), then a list grouped by day with columns for time, kind, title, area and source.
- **Week:** the calendar grid, with reminders, promises and runs as small outlined markers.

### Automations: what Atlas does on its own or on request

| | |
|---|---|
| ![Automations](screenshots/11-automations.png) | ![Goodnight](screenshots/12-automation-goodnight.png) |

- **Filters** by trigger: On request, Scheduled, Events (including absence), Watches.
- **Cards** show the trigger, the area, a one-line description, steps and powers, a strip of recent runs, and either **Run** (on-request automations) or an on/off switch.
- **Suggestions.** Atlas's suggested automation sits at the top ("You've asked for the shoot gear checklist 3 times"). A dashed card starts a new automation: "Describe it, or show Atlas once."
- **Opening a card** shows its flow: **When** → **Do** (numbered steps, each labeled with the power it uses) → **Report**. Below that come the powers it's **Allowed** (and which ask first), where it was **Made** ("Sep 14, from a chat"), and its **Runs** with time, duration, result and cost.

### Library: everything Atlas knows

| | |
|---|---|
| ![Library](screenshots/13-library.png) | ![Library, Areas](screenshots/14-library-areas.png) |

- **Overview.** Six outlined cells (People, Places, Areas, Collections, Memory, Files) with counts and recent items. Below them, **Recently learned**: each fact with its source and area, and a **Correct** link. Corrections replace a fact and keep the old value visible ("ends in 2290 · you corrected it Oct 18").
- **Areas** is where separation lives: "One memory. Areas decide what leaves." Each area row shows:
  - what's in it;
  - which account it sends from;
  - who it's shared with;
  - its faces;
  - what Atlas does there without asking;
  - whether it's private.

  Health is private: it never comes up outside its area or with anyone else.
- **People** is a table with relationship, areas, last contact, usual channel, and how much Atlas knows.

### History: everything behind you

![History](screenshots/15-history.png)

- **Tabs:** Everything, Actions, Conversations, Faces, Jobs.
- **The top strip** shows today's totals (actions, conversations, jobs, brain spend) and activity per hour.
- **The log** is a grid: time, who, what happened, area, receipt kind (`calendar.update`, `face.reply`, `acp.pr`…), and state (Undo, In Inbox, Running).
- **Opening a row** shows its path as a checks chain (You · chat → Atlas → `calendar.write` → iCloud) and the full receipt: asked by, what changed, what was checked, powers, brain and cost, undo, run id.

### Atlas settings

| | |
|---|---|
| ![Character and voice](screenshots/16-settings.png) | ![Brains](screenshots/17-settings-brains.png) |

The section list sits inside the sheet:

| Group | Sections |
|---|---|
| Atlas | Character & voice, Look & themes |
| Brains | Brains, Usage & limits |
| Connected | Connections, Devices, Vault |
| People | Members, Faces |
| Abilities | Skills & tools, Permissions |
| System | Notifications, Updates, Data & export |

- **Character & voice:**
  - the name;
  - four 5-step personality scales (Warmth, Humor, Directness, Initiative);
  - a "Sounds like" sample that changes with the scales;
  - ElevenLabs voices with previews;
  - speed, small talk and fillers.
- **Brains:** the fallback chain ChatGPT (Codex sign-in) → Claude (API key, $100/month cap) → Workers AI. Below it:
  - quick jobs on Workers AI (Clef decides, Clairic extracts, embeddings remember);
  - voice on ElevenLabs `eleven_v4_turbo`;
  - this month's spend.

### Light theme

![Inbox, light](screenshots/18-inbox-light.png)

## 4. Areas without profiles

Hermes-style profiles split memory and settings, and you switch between them. Atlas keeps **one memory** and treats areas as lenses:

1. **Filing is automatic.** Every message, event and record is tagged with areas as it comes in. A wrong guess is fixed by tapping its chip, and Atlas learns from the fix.
2. **The scope switcher is a focus, not a profile.** Picking Keyframes does three things:
   - Home, Inbox, Agenda and History filter to it;
   - Atlas leads with that area's context, accounts and tone;
   - non-urgent pings from other areas wait.

   Atlas still knows everything, so asking about Mom from inside Keyframes still works.
3. **The composer shows the area it guessed** before you send.
4. **Separation happens when something leaves Atlas.** Library → Areas sets accounts, sharing, faces, autonomy and privacy per area. A face or a member only ever sees its areas.
5. **New areas are suggested, never imposed** ("Atlas made Fitness on Sep 3, after 12 gym check-ins. You said yes.").

## 5. Visual language

**Type**
- Inter for the interface.
- Inter Tight for titles (`.disp`).
- Geist Mono for small uppercase labels, times, receipts and meters (`.mono`, `.lab`), used sparingly.

**Color tokens**

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--bg` | `#141413` | `#faf9f6` | Stage background |
| `--win` | `#1b1a19` | `#ffffff` | Sheets, cards, toolbar |
| `--side` | `#181716` | `#f4f3ef` | Sidebar |
| `--sep` / `--sep2` / `--dash` | `#2c2a28` / `#3a3835` / `#3f3c37` | `#e7e5df` / `#d9d6ce` / `#cdc9c0` | Rules, borders, dashed rails |
| `--tx` / `--tx2` / `--tx3` | `#f1efea` / `#aaa69e` / `#918d86` | `#191817` / `#5c5954` / `#6f6b65` | Text levels |
| `--ac` | `#ff6a3d` | `#e8501b` | Ember: what needs you, and what Atlas just changed |
| `--P` `--K` `--U` `--F` `--H` | `#f0458a` `#f5a524` `#3b82f6` `#10b981` `#8b5cf6` | `#d61f69` `#d97706` `#2563eb` `#059669` `#7c3aed` | Area colors (example areas): deep and saturated, not pastel (changed 2026-10-24) |

**Motifs, each used with a purpose**
- **Stage frame:** a dotted grid, dashed rails, and square nodes at intersections and sheet corners.
- **Atlas's selection:** a 1 px ember outline, square handles and a mono tag mark what Atlas just changed.
- **Checks chains:** outlined mono tags joined by dashes, for checks, paths, steps and fallbacks.
- **Flows:** outlined boxes, dashed connectors and nodes, for automations, helpers and brains.
- **Meters:** ASCII and segment meters for load, progress, runs and limits.
- **The ASCII diamond:** four facet layers that breathe. It appears only on Now and in voice.

**Rules**
- **Ember is rare.** It marks only what needs you, Atlas's changes and suggestions, and "now". Success is a quiet green ✓.
- **Avoid:** gradients, glows, orbs, blobs, generic right-side panes, vertical timelines, emoji, and decorative mono everywhere.
- **Motion** uses transforms and opacity only: rows rise in, selections pop in, connectors march, the jobs spinner turns, the waveform moves. Everything has a reduced-motion version.

**Copy**
- Short sentences in plain words, written as Atlas would say them ("Waiting on you", "Finished work lands in Inbox").
- No jargon in the main text. Technical detail goes in mono metadata.

## 6. Not designed yet

- **The phone app.** Planned as a tab bar: Home, Inbox, Agenda, Library, with the rest under Library and settings.
- **Setup:** the first ten minutes (VISION §22).
- **The ⌘K palette**, the area scope menu and the Pinned "+" flow.
- **Detail pages:** a person, a place, an area, a collection, Memory (journal and portrait), Files.
- **The vault's own screen**, and setting up a service step by step (M7, stage 3).
- **Pages and files Atlas makes** ([VISION §21.7](../../VISION.md#217-pages-and-files-things-atlas-makes)): a page screen, and how Library lists pages and files. The design itself still needs refinement.
- **Empty, loading, error and offline states.**
- **Themes beyond Dark and Light:** Terminal, Midnight, High contrast.

## 7. Working on these files

- **Editing.** Change a screen in the design canvas, or edit the builders in `source/builder/` and regenerate. [`source/builder/README.md`](source/builder/README.md) explains how.
- **The builders.** `shell.py` holds the shared shell (sidebar, toolbar, stage frame, composer, theme tokens), so a change there reaches every page when you re-run them.

## 8. M7: the new places and settings (approved 2026-10-24)

**Approved by the owner on 2026-10-24** (smoke test step 1 in [docs/M7.md](../M7.md)), with one change made after the review: the diamond on Now is smaller, finer, drawn from the real mark, and ember instead of the area colors. The decisions are in [VISION §21.2](../../VISION.md#212-eight-places). The built app's settings read as pre-alpha (browser controls, raw model ids, a paragraph under every control, one thing in three places), so these screens redo them against two bars: simplicity and Jarvis.

![The M7 screens](screenshots/m7/00-overview.png)

**What changes from UI v1**
- **Eight places.** People and Abilities join the sidebar after Library. Library keeps everything Atlas knows except people, which have their own place.
- **Abilities** opens on a live map: Atlas in the middle, with eight groups wired to it (brains, senses, channels, hands, services, skills, devices, and the exits it checks on the way out), each item with its state and cost. Clicking a group opens its tab.
  - **Changed 2026-10-24, after the owner's smoke test:** each group lists what it does, and clicking one zooms into its tree. The card grows to fill the stage; down a dashed rail with a square joint for each, what the group does; a dashed wire out to who does it, as chips with their logo and state, and dashed "add" chips for what the catalog has that isn't set up. A chip opens under its line with that service's options (the same panels as its card in Services) and a link to its whole card. Esc or the back link returns to the map. Devices leave the map's groups (they're under "Gets things done with", and the phone under "Where you are"), and **Talks to others with** takes their place: Atlas's own email address, its phone number and its faces. Built in `app/src/abilities/tree.ts` and `Zoom.tsx`; screenshots to be taken at the smoke test.
- **Services are cards,** one per service, whatever is underneath. A card opens in place: what Atlas hears from it, what it can do there (with when it asks), one key, what it can reach, what it costs, what happened lately and the rules that use it.
- **Skills** show their area, how often they're used, who made them and their check. Reuse is counted at the top.
- **People:** Contacts (trust, channels, areas, when you last talked), a person opened in place (what Atlas knows with each fact's source, threads, commitments, which faces may talk to them), Members (what stays private), and Faces as cards; a face opened shows its rules as a flow beside its conversations.
- **Atlas settings has five sections:** Atlas (character, voice, look), Brains (roles as chains, named brains, what each kind of work uses, providers with live limits, a model picker from the provider's catalog), Notifications (where things go, a list per urgency, quiet hours, focus, the budget, and Atlas's suggestions), Permissions (each kind of action, the locked floors, your own rules, and what Atlas no longer asks for), and Account (passkeys, the vault, updates and your data).
- **The app's own controls:** toggles, segmented choices and pickers. At most one short line under anything, sentence-case labels, and mono only for times, counts and meters.

**Color, real logos and plain words** (proposed 2026-10-24, after the owner found the UI colorless and too technical):
- **Real logos** for every outside service, in their own colors: from CC0 icon sets (Iconify's logos, Simple Icons) and the vendors' own icons where those don't have one (Outlook, Telnyx, OwnTracks). They're in [`source/builder/logos.json`](source/builder/logos.json). A black logo is inverted in the dark theme. In the app, each extension and catalog entry carries its own icon.
- **Color carries meaning, never decoration.** Areas are the color system: area chips are tinted, and a person's avatar takes the color of the area you know them from. Logos bring their brands' colors. Meters take the color of what they measure (Claude's orange, Cloudflare's). Ember stays rare: only what needs you and what Atlas just changed. Still no gradients or glows.
- **Simple is the default detail level** (VISION §21.5). It speaks in plain words ("Thinks with", "Keeps you safe", "Atlas thinks with ChatGPT, on your Plus plan") and hides model ids, speeds, prices per million tokens and mono metadata. Detailed and Developer show the rest, the way these screens first did. The soul stays at every level: the diamond, the stage frame, receipts and ember.

**Home's Now and the living diamond** (approved direction 2026-10-24):
- **The diamond** is the mark from `brand/atlas-mark.svg`, drawn finely in characters with hairline seams and its outline traced in slanted characters, so it keeps the mark's sharp points. It's in ember: lightest at the top left to deep red at the bottom right, lit by a light that circles it. It sweeps now and then while idle, ripples with your voice while listening, shimmers while thinking and pulses while speaking. Open [`source/diamond.html`](source/diamond.html) in a browser to see it move; it has controls for each state, an area and the theme. The screenshots here are single frames of it.
- **Now** shows what's next on a small map with when to leave, the weather with tomorrow's rain, what needs you, the jobs running, and the week stacked in area colors. Its builder is `p_now.py`.
- **Scoped to an area,** the stage's rails and the switcher take that area's color; the diamond stays ember.
- **People's photos** come from the address book where they have one (not drawn here, since the mockups use made-up people).

| | |
|---|---|
| ![Now](screenshots/m7/home-now.png) | ![Now, scoped to Keyframes](screenshots/m7/home-now-keyframes.png) |
| ![Now, light](screenshots/m7/home-now-light.png) | ![The diamond at 2x](screenshots/m7/home-now-diamond-2x.png) |

| Simple (the default) | Developer |
|---|---|
| ![Map, simple](screenshots/m7/abilities-map.png) | ![Map, developer](screenshots/m7/abilities-map-developer.png) |
| ![Brains, simple](screenshots/m7/settings-brains.png) | ![Brains, developer](screenshots/m7/settings-brains-developer.png) |
| ![Notifications, simple](screenshots/m7/settings-notifications.png) | ![Notifications, developer](screenshots/m7/settings-notifications-developer.png) |
| ![Permissions, simple](screenshots/m7/settings-permissions.png) | ![Permissions, developer](screenshots/m7/settings-permissions-developer.png) |
| ![A face, simple](screenshots/m7/people-face-open.png) | ![A face, developer](screenshots/m7/people-face-open-developer.png) |

| | |
|---|---|
| ![Map](screenshots/m7/abilities-map.png) | ![Services](screenshots/m7/abilities-services.png) |
| ![A service](screenshots/m7/abilities-service-open.png) | ![Skills](screenshots/m7/abilities-skills.png) |
| ![Devices](screenshots/m7/abilities-devices.png) | ![Map, light](screenshots/m7/abilities-map-light.png) |
| ![Contacts](screenshots/m7/people-contacts.png) | ![A person](screenshots/m7/people-person.png) |
| ![Members](screenshots/m7/people-members.png) | ![Faces](screenshots/m7/people-faces.png) |
| ![A face](screenshots/m7/people-face-open.png) | ![Faces, light](screenshots/m7/people-faces-light.png) |
| ![Atlas](screenshots/m7/settings-atlas.png) | ![Voice](screenshots/m7/settings-atlas-voice.png) |
| ![Look](screenshots/m7/settings-atlas-look.png) | ![Brains](screenshots/m7/settings-brains.png) |
| ![Model picker](screenshots/m7/settings-brains-picker.png) | ![Brains, light](screenshots/m7/settings-brains-light.png) |
| ![Notifications](screenshots/m7/settings-notifications.png) | ![Permissions](screenshots/m7/settings-permissions.png) |
| ![Account](screenshots/m7/settings-account.png) | ![Library](screenshots/m7/library.png) |

The builders are `p_abilities.py`, `p_people.py` and `p_settings.py` in [`source/builder/`](source/builder/); the screenshots were taken with its stand-in renderer (`preview.cjs`). Model names, prices and the example world's details are illustrative.

## 9. Home is the conversation (stage 6b, built 2026-10-25)

Built from [VISION §21.1, §21.2 and §21.4](../../VISION.md#211-the-shell-the-conversation-with-the-stage-it-opens) after the first real job, in the same look: the stage frame, one sheet, receipts, ember only for what needs you. It replaces the console docked under the stage and the ⌘J transcript.

- **The thread is the sheet.** Atlas's words read large in a centered column, with the receipts for what it did small under them; the owner's words are bubbles, with their area chip; the days are marked on a dashed rule. Times show on hover.
- **The stage opens from it,** beside the thread on a wide screen and over it on a narrow one, with a way back. Now and Week are pills at the right of the head; while the stage is open, what else is open on it sits beside them.
- **A job is a card** under the message that asked for it: its title and state, what Atlas is doing on it only while it is (with the spinner), its latest words, its files, and Stop. At Detailed it adds turns, tokens, cost and the coding agent. Tapping it opens its own thread on the stage, with a composer that goes straight to the job.
- **A question is a message** with what to look at or listen to (tracks play in place) and a button per option, or Reply in your words. Once answered it shows the answer. Inbox shows the same message, and "Show it in the conversation" lights it where it was asked.
- **Needs you** is one slim line above the composer, and opens Inbox.

| | |
|---|---|
| ![The conversation](screenshots/m7/home-conversation-dark.png) | ![A job's own thread](screenshots/m7/home-job-thread-dark.png) |
| ![The conversation, light](screenshots/m7/home-conversation-light.png) | ![A job's own thread, light](screenshots/m7/home-job-thread-light.png) |
| ![Now, opened from the conversation](screenshots/m7/home-now-open-dark.png) | ![A question, answered](screenshots/m7/home-question-answered-dark.png) |
| ![A job at work, Detailed](screenshots/m7/home-job-working-detailed-dark.png) | ![Empty](screenshots/m7/home-empty-dark.png) |
| ![The question in Inbox](screenshots/m7/inbox-question-dark.png) | ![Phone](screenshots/m7/home-conversation-phone.png) |

The phone's job thread is [`home-job-thread-phone.png`](screenshots/m7/home-job-thread-phone.png). These were taken from the app on a local server, with sample jobs, questions and files put in over its socket; the tracks and images are stand-ins.
