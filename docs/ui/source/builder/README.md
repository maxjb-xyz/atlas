# Building the UI v1 screens

These scripts generate the `.dc.html` screens in [`..`](..) (the design canvas format) and the screenshots in [`../../screenshots`](../../screenshots).

| File | What it does |
|---|---|
| `shell.py` | The shared shell: theme tokens and CSS, sidebar, toolbar (scope switcher, jobs button and dropdown, Talk, Search), stage frame, page header row, sheet, composer, and the `shellVals` / `mkTabs` helpers that every page's script uses. |
| `p_inbox.py`, `p_agenda.py`, `p_automations.py`, `p_library.py`, `p_history.py`, `p_settings.py` | One builder per page. Each one writes `../<Page>.dc.html`. |
| `p_home.py`, `p_voice.py` | Home and Voice started as hand-built files (`StageHome.src.html`, `StageVoice.src.html`). These builders lift their stage content onto the shared shell and add the Jobs tab. |
| `ascii_diamond.py` | Generates the four facet layers of the ASCII diamond from the logo's geometry. |
| `preview.js` | A small stand-in renderer for quick screenshots without the canvas runtime: `node preview.js out.png ../Inbox.dc.html '{"open":"gear"}' '{"theme":"Light"}'`. |
| `shoot_real.js` | Takes the screenshots in `../../screenshots` with the canvas's real runtime. Copy the runtime next to the screens as `../support.js` first (it's `artifact-type/dc-runtime.js` in the design artifact; it isn't committed here), then run `node shoot_real.js ../../screenshots`. |

To regenerate every screen, run this from this folder:

```sh
for f in p_*.py; do python3 "$f"; done
```

The output is deterministic, so if nothing changed, nothing changes. The scripts need Python 3 and, for screenshots, Node with Playwright.

**Format rules that bite** (the canvas runtime is strict):
- Templates only take plain `{{a.b}}` lookups, so compute everything in `renderVals()`.
- Loops and conditions are `<sc-for>` and `<sc-if>`. Never put them inside `<table>` or `<svg>`; use CSS grid instead.
- Events are `onClick="{{fn}}"`.
- The logic must be one `class Component extends DCLogic`. That's why the shared helpers are class methods, not top-level functions.
