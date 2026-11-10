## What

I made `tab.click(selector)` look its selector up again when the page re-renders the element out from under it, instead of sitting on the dead node until the 8 s timeout.

A selector click follows the replacement; a click on a replaced handle fails at once with advice to look it up again. This is Chromium-only (managed, relay and connected tabs); Tern and cmux already resolve selectors on each attempt.

| Call | main | this PR |
|---|---|---|
| `tab.click`, `dblclick`, `check`, `uncheck`, `uploadFile` chooser trigger, `frame.click`, `text/` clicks | polls the detached node until timeout | resolves the selector again |
| Handle, `tab.id(n)`, or `aria-ref` click | polls until timeout | fails at once |
| `check`/`uncheck` state-only paths | can accept or mutate a detached control | checks liveness before accepting state or clearing a radio |
| Timeout during re-lookup | stale detached-node report | lookup's own report, such as no matching elements |

## Why

A re-render can detach the node while the selector already matches its replacement. Polling the dead handle only spends the action budget; selectors can follow the replacement, but snapshot refs and handles deliberately cannot.

A click already dispatched is never retried: only detachment detected before dispatch enters the retry. Review `ElementDetachedError`, `withLiveElement` and `setElementChecked` in `interactions.ts`, then the selector callers in `tab-worker.ts` and `frames.ts`.

## Testing

`bun test packages/coding-agent/test/tools/browser-interactions.test.ts packages/coding-agent/test/tools/browser-upload-chooser.test.ts`: 55 passed, zero failed, using headless Chromium on macOS.

The existing replacement cases cover selector/text/frame clicks, replaced handles and chooser triggers. The new checkbox/radio case drives real Puppeteer handles through the same retry helper: stale matching checkbox states and a radio detached between its state read and mutation must affect the live replacement. Reverting the liveness fix fails that case with all three live states wrong; restoring it passes.

`bun run --filter './packages/coding-agent' check:types` passes. `bunx oxfmt --check` passes on all seven changed files.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
