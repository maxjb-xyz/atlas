# Atlas

Read [VISION.md](VISION.md) first: it's the founding brief, and every change must agree with it or change it in its own commit. M0 to M6 are closed ([docs/M0.md](docs/M0.md), [docs/M1.md](docs/M1.md), [docs/M2.md](docs/M2.md), [docs/M3.md](docs/M3.md), [docs/M4.md](docs/M4.md), [docs/M5.md](docs/M5.md), [docs/M6.md](docs/M6.md)); the current milestone is M7, launch, and [docs/HANDOFF-M7.md](docs/HANDOFF-M7.md) has where M6 left things, what's still open and the plan. M7's own doc, `docs/M7.md`, starts with its smoke test.

A milestone is done when its smoke test passes on the owner's real deployment (VISION rule 7), not after a week of use. Write the smoke test before building, and keep earlier milestones' smoke tests as regression lists.

## Layout

- `core/`: the Worker and the person agent (TypeScript, Cloudflare Agents SDK). Its size is reported at each milestone's close (VISION rule 4).
- `extensions/`: everything tied to one service (VISION §17), each `extensions/<id>/index.ts` against `extensions/sdk.ts`, sandboxed in a Dynamic Worker whose only way out is the core's gate. `npm run extensions` bundles them into `core/src/extensions.gen.ts` (`check`, `dev` and `deploy` run it). Nothing service-specific goes in `core/`.
- `app/`: the web app (React, Vite), served by the Worker. UI v1 is locked in [docs/ui/](docs/ui/README.md).
- `desktop/`: the desktop app (Tauri, Rust): Atlas in a window, and the first node (VISION §16.3). Built for the Mac by `.github/workflows/desktop.yml`, only on a published release.
- `bench/`: the voice latency benchmark, run against a deployed Atlas.
- `docs/ui/`, `brand/`: the locked UI and the diamond mark.

## Commands

- `npm run check`: typecheck everything, run core tests in the Workers runtime, build the app. Run it before every commit.
- `npm run format`: prettier (print width 140).
- `npm run dev` / `npm run deploy`: need `wrangler login`; Workers AI only runs against a real account.

## Rules that bind code

- Never add code that rewrites, filters or second-guesses the model's output (VISION §3 rule 1). Fix the character (`core/src/character.ts`), the context, a tool's description, or the tool.
- One of everything: one loop (`core/src/loop.ts`), one log (`core/src/store/log.ts`), one clock (`core/src/store/agenda.ts`), one way out (`core/src/outbox.ts`). A new mechanism must replace one.
- Every run ends in exactly one saved state: replied, deferred or failed.
- No behavior flags. Settings are for people, and each one has a place in the app.
- Nothing optional costs until it's used (VISION §19.3): a channel, sense, provider or surface deploys nothing that bills and runs nothing until the owner turns it on, then costs only while in use (a webhook, not a held connection; a container that sleeps). If it must stay on, Settings says what it costs before it's turned on.
- Tests use fake brains and calendars through `seams` in `core/src/agent.ts`; never call a real provider from tests.
- Make failures explain themselves: keep the HTTP status, the host and the provider's own words in errors and Worker logs. Most bugs only show on the real deployment, and a generic message costs a round trip with the owner.
- House style for docs, comments and UI copy: plain sentences, sentence case, no em dashes, they/them for people whose pronouns we don't know.

Old Atlas is at [atlas-legacy](https://github.com/maxjb-xyz/atlas-legacy) for reference: ideas carry over, code doesn't.
