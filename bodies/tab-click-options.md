## What

I asked omp to right-click a list item so it could open the item's menu, and it left-clicked instead and opened the item's details, so `tab.click` and `frame.click` now press the button and count they're asked for, as element handles already do.

In a benchmark task whose actions sit behind a right-click menu (GPT-6.1 Sol, this PR merged with other queued browser fixes), median steps went from 19.5 to 14.5, because the first `tab.click(chip, { button: "right" })` now opens the menu instead of the item's details.

| call | `main` | this PR |
|---|---|---|
| `tab.click(sel, { button: "right" })`, Python `tab.click(sel, button="right")` | one left click | a right click (`contextmenu` fires) |
| `tab.click(sel, { count: 2 })` | one left click | a double click |
| `(await tab.frame(…)).click(sel, { button: "right" })` | one left click | a right click |
| the same on Tern | one left click | the requested button and count |
| the same on cmux | one left click | refused, as cmux element handles already refuse it (cmux only left-clicks once) |
| `tab.click(sel)` | unchanged | unchanged |

## Why

Puppeteer's `page.click(selector, { button })` is the shape models reach for, and Python keyword arguments become exactly that trailing options object, but the selector forms took one argument and dropped the rest. The page then got a left click, which on most UIs does something else: in a project-canvas benchmark, the first right-click on a volume opened its read-only details drawer instead of its context menu in 5 of 5 runs, and each run spent 3 to 4 more steps closing the drawer, inspecting the markup and right-clicking through raw Puppeteer in `tab.run`.

Element handles have taken `{ button, count }` since #14232 on all three backends; this gives the selector forms the same options and the same per-backend handling. Text-query selectors (`text/…`) pass them through too.

- **Decision.** Accept the options rather than refuse an unexpected second argument: the click machinery already takes them, and a refusal would send the agent to `tab.id(n).click({ button })` for a call it already wrote correctly.
- Docs: one sentence in the browser tool prompt and in `docs/tools/browser.md`.
- Non-goal: `page.locator(sel).click({ button })` inside `tab.run` on Tern and cmux still takes no options, as on `main`.

## Testing

- Managed Chrome, headless Chromium (`browser-interactions.test.ts`): `tab.click("#menu", { button: "right" })` fires `mousedown:2` and `contextmenu:2`, `tab.click("text/Menu", { count: 2 })` fires `dblclick`, and `frame.click` right-clicks inside an iframe. On `main` every one is a single `mousedown:0`.
- Tern, fake daemon (`browser-tern-tab.test.ts`): a selector right-click sends right-button down/up; on `main`, left.
- cmux, stubbed socket (`browser-cmux-element-click.test.ts`): `tab.click(sel, { button: "right" })` and `{ count: 2 }` reject and send nothing; on `main` both send one left click.
- Python: the prelude sends `tab.click("#menu", button="right")` as `click("#menu", { button: "right" })`.

```sh
cd packages/coding-agent && bun test test/tools/browser-interactions.test.ts test/tools/browser-tern-tab.test.ts test/tools/browser-cmux-element-click.test.ts
```

Risk: low. Calls without options behave as before on every backend.

---

- [x] `bun run check:ts` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
