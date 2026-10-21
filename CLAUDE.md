# Atlas

Read [VISION.md](VISION.md) first: it's the founding brief, and every change must agree with it or change it in its own commit. M0 is done ([docs/M0.md](docs/M0.md)); the current milestone is M1, and [docs/HANDOFF-M1.md](docs/HANDOFF-M1.md) has where things stand and the plan.

A milestone is done when its smoke test passes on the owner's real deployment (VISION rule 7), not after a week of use. Write the smoke test before building, and keep earlier milestones' smoke tests as regression lists.

## Layout

- `core/`: the Worker and the person agent (TypeScript, Cloudflare Agents SDK). The core runtime has a 25k-line budget (VISION rule 4).
- `app/`: the web app (React, Vite), served by the Worker. UI v1 is locked in [docs/ui/](docs/ui/README.md).
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
- Tests use fake brains and calendars through `seams` in `core/src/agent.ts`; never call a real provider from tests.
- Make failures explain themselves: keep the HTTP status, the host and the provider's own words in errors and Worker logs. Most bugs only show on the real deployment, and a generic message costs a round trip with the owner.
- House style for docs, comments and UI copy: plain sentences, sentence case, no em dashes, they/them for people whose pronouns we don't know.

Old Atlas is at [atlas-legacy](https://github.com/maxjb-xyz/atlas-legacy) for reference: ideas carry over, code doesn't.
