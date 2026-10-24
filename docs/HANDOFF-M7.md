# Handoff: M6 closed, M7 next

**Date:** 2026-10-23. **From:** the M6 build. **For:** whoever builds M7, human or agent.

Read [VISION.md](../VISION.md), [CLAUDE.md](../CLAUDE.md) and [docs/M6.md](M6.md) first. This page covers what M6 left behind: where things stand, what we learned, what's still open, and a suggested order for M7.

## 1. Where things stand

- **M6 is closed** by the owner, after a coding job on `atlas-maxjb/reverb` ran on the deployment from the clone, through the agent's work and Atlas's review, to an opened pull request. Steps not yet run on the deployment are carried into M7 ([M6.md §8](M6.md#8-carried-into-m7)).
- **The deployment** is the owner's Cloudflare account at a workers.dev address, deployed by hand (pushing doesn't deploy). It runs M6 up to the gate's diagnostics (commit `10e2d68`), with the workspace at `standard-1`.
- **The code** is on branch `claude/affectionate-keller-heljnn` of `maxjb-xyz/atlas` and isn't merged to `main` yet. Merge it (or open a PR) before branching for M7.
- **The checks** are `npm run check`: bundling the extensions, typecheck, 345 tests in the Workers runtime, and the app build. All pass.
- **The size** (rule 4) is about 32,300 lines of core runtime, up from 28,800 at M5's close, plus 3,750 lines of bundled extensions outside the core and 12,800 in the app. What grew: the coding desk (`core/src/agent/coding.ts`, about 1,660: a job's steps, its looks, the owner's answers, the pull request), the workspace's side of jobs (about 730: the bridge, job users, saves to R2, the gate's leases and diagnostics), the ACP client (265), the bridge (200), and the job tools (200). What M6 kept out of the core: each coding agent (Codex, Claude Code) and the code host (GitHub's `git`, `repos`, `repo` and `pull_request`) are extensions; the core knows ACP and git, which are open standards.
- **Working today**, on top of M5:
  - coding jobs over ACP (VISION §8.2) in the workspace container, with Codex or Claude Code, each job on its own branch, as its own Linux user, with its own folder;
  - the bridge, which keeps a job's agent running across a deploy and holds what it printed until the core reads it;
  - the gate per job: the agent reaches only its model and the sites the owner allowed; the code host's key is added only for Atlas's own git steps, scoped to the job's repo, never on a command line; the owner's vault keys are off while jobs run;
  - Atlas as the middleman: a short look at each turn's end that answers the agent, asks the owner, runs a check, or calls the job ready or given up; the owner's answers, approvals and Stop written down at once and taken on the job's next wake;
  - the review and the pull request: Atlas commits as the job's user, pushes from a copy as root, and opens the PR through the outbox with a receipt;
  - Jobs and Home show a job (the locked design), Inbox shows a job's question, Telegram carries its buttons;
  - research jobs: a helper with its own budget that reports progress and lands a view and a page;
  - helpers whose lease renews on progress, so a long one isn't called lost.

## 2. What M6 taught us

M0 to M5's lessons still hold. M6 added these (more in [M6.md §6](M6.md#6-found-while-building)):

- **Treat a coding agent as a stranger.** It reads a repo anyone could have written, so anything it can see, it might be steered to send. The first design ran it as root beside Atlas's git steps; four reviews by area turned that into a model: its own user, keys only at the gate and scoped to one repo, root touching its work only as data.
- **Fakes hide the gate.** The tests' fake workspace skipped the network gate, so the first real clone was refused. Test the gate's decision itself, not just the steps around it.
- **A refusal with no words costs a round trip.** A bare 429 from GitHub meant another deploy just to see what happened. The gate now keeps what it did and what the site said, and puts it in the error.
- **Short looks beat one long wait.** Holding a helper open for an hour of agent work would have held a fiber and a budget; a look per turn, with the job's state in the agent object, waits for free and survives a deploy.
- **The owner's words never queue behind a long step.** Write them down at once; let the next wake take them.
- **Tests must wait for what they start.** A failed job's background report took the next test's scripted answer.
- **Verify on the real adapters before building.** Running Codex's and Claude Code's ACP adapters against fake model servers, before any core code, found the inherited sign-in token, the session reload and the permission requests, and each one shaped the build.

## 3. Open issues carried into M7

### 3.1 Not yet checked on the deployment

Everything in [M6.md §8](M6.md#8-carried-into-m7): questions reaching the owner, Steer and Stop, isolation, voice, a deploy mid-run, Claude Code, two jobs, long and stalled jobs, research, and Codex on the plan route. Then [M5.md §5b](M5.md#5b-carried-into-m6), [M4.md §7](M4.md#7-carried-into-m5), and the earlier lists.

### 3.2 Voice latency (an M0 exit check that still isn't met)

Unchanged since [HANDOFF-M4.md §3.3](HANDOFF-M4.md#33-voice-latency-an-m0-exit-check-that-still-isnt-met). A public release should meet it, or say plainly that it doesn't yet.

### 3.3 Smaller items

- **From M6's "not built":** Preview as a step in Jobs; coding agents kept in a snapshot instead of installed again after the workspace sleeps; a deploy at the wrong moment can send the agent one prompt twice.
- **The 429** from GitHub on the first clones: its cause wasn't seen. If it comes back, the error says what GitHub said.
- **Members** still have no workspace or coding jobs of their own.
- **From M5:** Gmail's push instead of a look; stage views as images in a chat; moving one occurrence of a repeating event; a member's own passkeys in their Settings ([HANDOFF-M6.md §3.3](HANDOFF-M6.md#33-smaller-items)).

## 4. M7: launch

From VISION §25, M7 proves **someone else can install it and love it**: setup polish (§22 steps 6 and 7), moving in (§23.3), all themes (§21.9), ambient mode, docs, the "Deploy to Cloudflare" button, and a public release.

### Suggested order

1. **Groundwork:** merge M6; run M6's carried steps with the owner and fix what they find; write M7's smoke test (`docs/M7.md`) from the draft in §6. Settle the open questions a release needs (VISION §26): repo visibility (proposed private until launch), the license (MIT or Apache-2.0), the default assistant name (proposed "Atlas"), and whether the "ChatGPT Atlas" name matters.
2. **The deploy button first:** a fresh Cloudflare account, the button in the README, and nothing else. Everything later in setup is tested from there (VISION §22's rule: setup is tested on a fresh account with every release). Note what Containers, Workers AI, Email and the rest need turned on in a new account, and keep VISION §19.3: nothing optional bills until it's used.
3. **Setup steps 1 to 5 again, then 6 and 7:** the first useful act through a real approval, the default routines offered off, and the optional extras (faces, Atlas's email, members, coding jobs, home devices, moving in) appearing when they're relevant. Every check is a live test with a plain reason and a fix; nothing needs a terminal. Time it against the 10-minute target.
4. **Moving in:** imports from ChatGPT and Claude exports, Hermes and OpenClaw memory files, and contacts, through the same extraction as connections, showing what was learned. Each format is an extension-like reader; the extraction is the core's.
5. **All themes:** Terminal, Midnight and High contrast beside Graphite and Daylight, the owner's tweaks (accent, font pair, density, motion), custom themes as a shareable file, and a contrast check in `npm run check`.
6. **The last views** (VISION §21.6): ambient mode (a full-screen, always-on view of "now", §21.8), media and the 3D model. None is drawn in [docs/ui/](ui/README.md) yet, so each gets its design pass with the owner before it's built.
7. **Docs and the release:** a README a stranger can follow, what each optional piece costs, the Updates page's one-click update and rollback (§23.2), and a tagged release (which also builds the Mac app, `.github/workflows/desktop.yml`).

Keep the invariants: one loop, one log, one clock, one way out, one intake. Nothing tied to one service in the core.

## 5. Where to put things

[HANDOFF-M6.md §5](HANDOFF-M6.md#5-where-to-put-things) still holds. M6 added:

| To add | Do this |
|---|---|
| A coding agent (OpenCode, Gemini CLI) | An extension that provides `coding` with an `agent` (its install, its command, its environment and the gate keys for its model), against `CodingAgent` in `extensions/sdk.ts`. See `extensions/codex` and `extensions/claude-code`. |
| A code host (GitLab, Forgejo) | An extension that provides `code`: a `git` spec (its host and how its key goes on git's requests) and the `repos`, `repo` and `pull_request` calls. See `extensions/github`. |
| Something a job's look can do | A tool in `JOB_TOOLS` (`core/src/tools/coding.ts`), done in `CodingDesk.#act` (`core/src/agent/coding.ts`). |
| Something the owner can do to a job | An owner tool in `core/src/tools/coding.ts`, or a socket message in `core/src/protocol.ts` handled in `core/src/agent.ts`; anything that changes a running job goes through the job's mail, taken on its next step. |
| Something a job does in the container | A `job…` method on `Workspace` (`core/src/workspace.ts`) that runs as the job's user (`as`), never as root on the job's files. |
| A key on the workspace's gate | A `KeyRule` (host, header, value, and a nonce and a path where it must be scoped), leased for a job or carried by one command; never on a command line or in a job's environment. |

## 6. A first draft of M7's smoke test

Finish this from the final M7 scope, and the owner's choices in §4, before building.

**Install**
- [ ] On a fresh Cloudflare account, the README's "Deploy to Cloudflare" button deploys Atlas with nothing else done by hand; the app opens.
- [ ] Setup, from the passkey to Atlas saying something useful about the week, takes under 10 minutes on Workers AI alone, with no terminal.
- [ ] Every setup step can be skipped and picked up later; a failing check gives a plain reason and a fix there.
- [ ] The first useful act goes through a real approval; the default routines are offered, each off.
- [ ] Nothing optional bills before it's turned on: the account's usage after setup shows no container, phone or paid provider.

**Moving in**
- [ ] A ChatGPT export and a Claude export import, and Atlas shows what it learned, each item to keep or drop.
- [ ] A Hermes or OpenClaw memory file imports the same way; skills carry over unchanged.

**Themes and ambient**
- [ ] Each built-in theme renders every place and stage view; the contrast check passes in `npm run check`.
- [ ] The owner's tweaks and a custom theme file apply live and follow the system's light or dark setting.
- [ ] Ambient mode runs full screen on a tablet on a stand and keeps "now" current all day, as drawn.

**Release**
- [ ] A tagged release builds the Mac app, and the Updates page updates the deployment and rolls it back.
- [ ] Someone other than the owner installs it from the README alone.

**Regression**
- [ ] M6's carried steps ([M6.md §8](M6.md#8-carried-into-m7)), M5's ([M5.md §5b](M5.md#5b-carried-into-m6)), M4's ([M4.md §7](M4.md#7-carried-into-m5)), then M6's smoke test and the earlier lists.
