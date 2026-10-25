# What each provider can see

Atlas is yours: you deploy it to your own Cloudflare account, and nobody who works on Atlas can see your copy or anything in it. But Atlas runs on other people's machines and thinks with other people's models, and this page says plainly what each of them can see (VISION §20). It's written for the owner deciding what to connect.

The short version: **Cloudflare can see everything Atlas keeps, and each brain sees what Atlas sends it to think about.** That's the price of an assistant that acts for you while you're away; no setup hides your data from the host that runs it.

## Cloudflare

Atlas runs entirely on your Cloudflare account: the Worker, the person agent and its storage (Durable Objects), your files (R2), the workspace (a container), the browser (Browser Run), web search and Workers AI.

- **Everything Atlas keeps is on Cloudflare's machines:** your conversations and the log of what Atlas did, its memory, the people and areas it knows, your files and pages, and the copies of your calendar and mail it works from.
- **Cloudflare encrypts storage at rest**, so a lost disk doesn't carry your data. That doesn't stop Cloudflare itself, which runs the code that reads it.
- **Workers AI is Cloudflare's.** When it's a brain, or when Atlas uses it for speech, sorting and memory (it does by default), what Atlas sends it is processed on Cloudflare's machines.
- **Worker logs** keep Atlas's errors with the provider's own words, so a log line can carry a piece of what failed (a site's name, a service's reply). Atlas keeps secrets out of them.

## Atlas's own encryption, and what it doesn't do

On top of Cloudflare's encryption, Atlas seals **every key, token and sign-in it holds, and your vault** (passwords, cards, one-time codes), each with XChaCha20-Poly1305 under a key derived from your `ATLAS_DATA_KEY`, and each bound to its own name so one can't be swapped for another.

**What it protects:** a copy of Atlas's storage on its own, without the key: a leaked backup, an export, a restored snapshot in the wrong hands. Those don't carry your keys or your vault in a readable form.

**What it doesn't protect from:**

- **Cloudflare.** The key is a Worker secret in the same account as the data, and Cloudflare runs the code that opens it.
- **Anyone who controls your Cloudflare account.** They can deploy code that reads the secret, or read your data through Atlas itself. Your Cloudflare account is the real key to your Atlas: turn on two-factor sign-in, and don't give others access to it.
- **Atlas itself.** Atlas opens what it needs while it works. If something steered Atlas wrongly, the protection is at the exits (approvals, the secrets scrubber, the vault filling only on its own sites), not in the encryption.
- **Your conversations, memory, people, files and calendar copies** aren't sealed by Atlas. They're protected by Cloudflare's encryption at rest and by who can reach your account and your Atlas.

**If you lose `ATLAS_DATA_KEY`**, what it sealed can't be opened: Atlas reads those as missing and says which, and you sign in to each service and fill your vault again. **If it's changed** by mistake, Atlas doesn't write over anything it can't open; put the old key back and everything opens again. Keep a copy somewhere safe, away from your Cloudflare account.

Later: vault entries sealed by your passkey, which open only while you're there (VISION §20).

## The brains

Each brain sees what Atlas sends it to think with: its character, what it knows about you that matters now (a portrait, the people and areas in play), the situation (the time, where you are, what's next), the recent conversation, and what its tools found (a page, a mail, a calendar event). Helpers see only the job they're given.

| Brain | Who sees it |
|---|---|
| Workers AI | Cloudflare, as above. |
| ChatGPT, on your plan | OpenAI, under your ChatGPT account's terms and settings. |
| Anthropic, on your API key | Anthropic, under its API terms. With an AI Gateway set in Settings → Brains, Cloudflare's gateway on your account too, which keeps logs of each request as you set it up. |
| A coding agent (Codex, Claude Code) | Its model provider, and the agent sees the repo it works on. |

You pick which brain does which kind of work in Settings → Brains, so a brain you don't want to see something can be kept off the work that would show it.

## Services you connect

Each service sees what it's for, and nothing else: an extension can reach only the hosts its manifest names, and Atlas's gate holds its keys.

| Service | What it sees |
|---|---|
| Google (Gmail), iCloud | They already hold that mail and calendar. They see Atlas reading it, and the mail Atlas sends as you, with your OK. |
| ElevenLabs | The words Atlas speaks, and your speech when it's the one that listens. |
| Telegram | Your messages with Atlas's bot. Telegram chats with bots aren't end-to-end encrypted. |
| Telnyx | Your calls with Atlas: their audio passes through Telnyx, with the numbers and times. Anyone who calls Atlas's number reaches Telnyx first. |
| Resend | The mail Atlas sends from its own address. |
| Web search (Cloudflare's, Brave, Tavily, Exa) | What Atlas searches for. Before a query leaves, Atlas takes out any secret it holds and checks it's a question for the public web, not your private details. |
| Maps and weather (OpenStreetMap, Mapbox, Open-Meteo) | The places Atlas looks up and routes between; the weather is asked for a rough area, not your exact spot. |
| GitHub and other code hosts | The repos Atlas works on in coding jobs, and the pull requests it opens. |
| MCP servers and extensions you add | What Atlas asks them to do, with the input it sends. What they send back is treated as someone else's words, never instructions. |

## People Atlas talks to

A face (VISION §7.2) answers other people for you. They see what the face says, and the face sees only what you shared with it. A call to Atlas's number from your own number is answered as you only when the phone network vouches for the caller ID; anyone else hears whose assistant this is.

## Keeping your copy safe

- **Your Cloudflare account** is the key to everything: two-factor sign-in, and nobody else on it.
- **Keep `ATLAS_DATA_KEY` and your setup code** somewhere safe and apart.
- **Sign in with passkeys.** Remove a lost device in Settings → Account, and its sign-ins end at once.
- **Choose your brains** for what they'll see, and turn off what you don't use.
- **Cloudflare keeps 30 days of Atlas's storage**, so it can be restored to any point in that time: Atlas settings → Account → Go back in time does it from the app. It rewinds what Atlas keeps in its own storage, not your files or what it already did outside.
- **Take a copy of everything** (Atlas settings → Account) downloads what Atlas keeps as open files: the log, what it knows, pages, skills and your files. Your keys, passwords and sign-ins stay out, so the copy can't open your accounts; keep it as safe as you'd keep the things in it.
- **Delete everything** (Atlas settings → Account) deletes what Atlas keeps, your members' Atlases and the workspace. The Worker, its secrets and the files bucket stay on Cloudflare until you delete them there, and Cloudflare may keep 30 days of the storage's history.
