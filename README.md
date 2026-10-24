<p align="center"><img src="brand/atlas-mark.svg" width="72" alt="Atlas"></p>

# Atlas

Atlas is a personal AI that feels like Jarvis. You talk to one character by voice or text. It knows your life, sees what's happening around you, does real work, deals with other people for you, and keeps going while you're away.

It's open source, and you deploy your own copy to your own Cloudflare account with one click. Your Atlas is yours: nobody else runs it, and nothing is shared with us.

> **Status: M7, the launch milestone, is being built (2026-10-24).** Atlas isn't released yet. M0 to M6 are closed; [docs/M7.md](docs/M7.md) has what's built, what's left, and the smoke test a release has to pass. Until the first release, the button below deploys whatever is on the main branch.

![Atlas](docs/ui/screenshots/m7/00-overview.png)

## What it does

- **Talk to it** in the app by voice or text, in Telegram, or by phone through Telnyx. It's one Atlas everywhere, with one memory.
- **It knows your life:** your calendar, mail, contacts, where you are, the people and the areas of your life, and what you told it.
- **It speaks up** when something matters (leave now for the dentist, the flight moved), and stays quiet when it doesn't.
- **It does real work:** looks things up, runs code in a workspace of its own, browses, makes files, and takes on long jobs ("make a launch video", "plan the Lisbon trip") that it owns over days, checking with you at the points that matter.
- **It deals with people for you** through faces: a version of Atlas that answers someone else, sees only what you allow, and brings you what needs you.
- **It asks first** before anything leaves Atlas or can't be undone, by rules in its code, not its judgment. You set the rules in Permissions.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxjb-xyz/atlas)

**What your Cloudflare account needs:**

- The **Workers Paid** plan ($5 a month). Atlas's workspace (a container) and its Durable Objects need it.
- **Workers AI**, **R2** and **Containers** turned on for the account. Workers AI comes with every account and has a free daily allowance; R2 and Containers may ask you to accept their terms the first time.
- Browser Run (Cloudflare's browser) is used when Atlas browses, and billed only then.

**The button asks for two secrets:**

| Secret | What it is |
|---|---|
| `ATLAS_OWNER_SECRET` | Your setup code: 16 or more characters you'll remember for a few minutes. You type it once in the app to make your passkey, and again only if you ever lose every passkey. |
| `ATLAS_DATA_KEY` | Atlas's own key for locking your keys, sign-ins and vault: 32 or more random characters. **Keep a copy somewhere safe.** If it's lost, what it locked can't be opened: you'd sign in to each service and fill your vault again. |

Then open your Atlas's address (the button shows it), type your setup code, and make a passkey. Setup takes you from there: name and voice, a brain, your calendar and mail, and Atlas's first look at your week. Every step can be skipped and picked up later, and nothing needs a terminal.

## What it costs

Atlas itself is free. What you pay is your Cloudflare plan and what you choose to use:

| Part | Cost |
|---|---|
| Cloudflare Workers Paid | $5 a month, with generous allowances for requests and storage |
| Workers AI (the default brain, voice, sorting and memory) | A free allowance each day, then a few cents for heavy use |
| The workspace (a container) | Only while it's awake; it sleeps after ten quiet minutes |
| ChatGPT as a brain | Your ChatGPT plan, signed in; no extra cost |
| Anthropic as a brain | What you use, on your Anthropic API key |
| ElevenLabs voice | Your ElevenLabs plan |
| Telnyx phone calls | About 1¢ a minute while you're on a call, and $1 a month for a number bought through Atlas |
| Other services (Telegram, Gmail, iCloud, GitHub, search) | Their own plans; most are free |

Nothing optional costs anything until you turn it on, and then only while it's in use. Anything that must stay on says what it costs before you turn it on.

## Privacy and security

Atlas runs on Cloudflare's machines and reads your data so it can act for you while you're away. That means **no setup hides your data from the host that runs it**, and each brain you pick sees what Atlas sends it. Atlas encrypts your keys, sign-ins and vault itself, on top of Cloudflare's own encryption at rest, so a leaked copy of storage, a backup or an export doesn't carry them; but the key is a secret in the same Cloudflare account, so it doesn't protect you from Cloudflare or from someone who controls your account.

[docs/PRIVACY.md](docs/PRIVACY.md) says plainly what Cloudflare and each provider can see, what Atlas's encryption does and doesn't do, and how to keep your copy safe. Read it before you connect your mail.

## Updates

Atlas looks for a new release once a day and shows it in Atlas settings → Account → Updates with what changed, with one click to update and one to go back. The first time, it asks for a Cloudflare API token that can edit your Workers ("Make the token on Cloudflare" opens Cloudflare's page with that filled in). Each update checks every file of the release against its listed SHA-256 before uploading anything, then puts it in as a new version of your Worker with your bindings and secrets as they are. A release's changes to storage only add, which `npm run check` enforces, so going back to older code never breaks your data.

If you deployed with the button, your copy of the repository is connected to Workers Builds, and a push there deploys over what you installed from the app. Disconnect it (Workers & Pages, your Atlas, Settings, Build) if you update from the app; Atlas also says so when a version it didn't install replaces one it did. A release that changes Atlas's Durable Objects can't go in as a version: the Updates page says so and what to run instead.

## Read more

| | |
|---|---|
| [VISION.md](VISION.md) | What Atlas is and how every part works: the core loop, memory, areas, faces, helpers, jobs, voice, approvals, automations, the vault, brains, the platform, the UI, setup and the build order. |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What Cloudflare and each provider can see, and what Atlas's own encryption covers. |
| [docs/M7.md](docs/M7.md) | The launch milestone: its smoke test, what's built and what's left. |
| [docs/ui/](docs/ui/README.md) | The app's design: every place and screen, the visual language and its sources. |
| [docs/CHARACTER.md](docs/CHARACTER.md) | Atlas's character, and the eval that checks every brain against it. |
| [CLAUDE.md](CLAUDE.md) | How the code is laid out and the rules that bind it, for anyone working on Atlas. |
| [brand/](brand/) | The diamond mark and app icons. |

Earlier milestones are in [docs/](docs/) (M0.md to M6.md, with a handoff before each). Old Atlas is kept for reference at [atlas-legacy](https://github.com/maxjb-xyz/atlas-legacy); ideas carry over from it, code doesn't.
