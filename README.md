<p align="center"><img src="brand/atlas-mark.svg" width="72" alt="Atlas"></p>

# Atlas

Atlas is a personal AI that feels like Jarvis. You talk to one character by voice or text. It knows your life, sees what's happening around you, does real work, deals with other people for you, and keeps going while you're away.

It's open source and self-deployed with one click to Cloudflare.

> **Status: M0 done (2026-10-21), M1 next.** M0, the voice and core prototype, runs on the owner's Cloudflare account and passed its smoke test. [docs/M0.md](docs/M0.md) covers deploying it and what it found; [docs/HANDOFF-M1.md](docs/HANDOFF-M1.md) covers what's open and the plan for M1 ([VISION.md §25](VISION.md#25-build-order)).

![Atlas UI v1](docs/ui/screenshots/00-overview.png)

## Read this first

| | |
|---|---|
| [VISION.md](VISION.md) | What Atlas is, why it's a fresh start, and how every part works: the core loop, memory, areas, faces, helpers, voice, approvals, automations, the vault, brains, the Cloudflare platform, the UI, setup, and the build order. |
| [docs/ui/](docs/ui/README.md) | UI v1, locked Oct 21, 2026. It has the shell, the six places, screenshots of every screen, the visual language, and the source files. |
| [docs/M0.md](docs/M0.md) | The first milestone: deploy, benchmark, the smoke test and what it found, and the decisions made while building. |
| [docs/HANDOFF-M1.md](docs/HANDOFF-M1.md) | Where things stand after M0, how we work (smoke tests in place of a week of use), open issues, and the M1 plan. |
| [brand/](brand/) | The diamond mark and app icons. |

Old Atlas is kept for reference at [atlas-legacy](https://github.com/maxjb-xyz/atlas-legacy). Ideas carry over from it, code doesn't.
