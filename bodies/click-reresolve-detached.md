## What

I made `tab.click(selector)` look its selector up again when the page re-renders the element out from under it, instead of sitting on the dead node until the 8 s timeout.

On a list that re-renders after a request, `tab.click` went from an 8 s timeout ("the element never became clickable (last check: detached …); selector matches 1 element(s)") to clicking the new element at once; a click on a handle whose element was replaced now fails at once instead of timing out.

> **Browser context.** A selector click resolves its element once, then polls it until it is clickable. A re-render (`innerHTML`, a framework swapping a list) leaves that node detached from the document, while the selector already matches its replacement.

| Call | main | this PR |
|---|---|---|
| `tab.click`, `dblclick`, `check`, `uncheck`, `uploadFile` (chooser trigger), `frame.click`, `text/` clicks, element replaced before the click | waits 8 s, then times out naming `detached` | resolves the selector again and clicks the new element |
| `handle.click()`, `tab.id(n).click()`, `aria-ref` selectors on a replaced element | waits 8 s, then times out | fails at once: "the page replaced this element …; look it up again" |
| Timeout after a replacement, while clicking | `last check: detached (…)` | `last check: detached (the page kept replacing this element)` |
| Timeout after a replacement, while looking the selector up | `last check: detached (…)` | the lookup's own report, e.g. "selector currently matches no elements" |

Reading order: `ElementDetachedError` and the `detached` flag in `isClickActionable` (`interactions.ts`), then `withLiveElement`, then its callers: `#clickSelector` and `#prepareTabUpload` in `tab-worker.ts`, `click` in `frames.ts`, and the re-query in `clickQueryHandlerText`.

## Why

The page check already knew the node was detached and said so, but the loop kept polling it until the deadline. A detached handle cannot come back after a re-render, so polling it only spends the action budget. When the caller passed a selector, looking it up again is what the advice in the message asks the agent to do by hand.

Decisions:
- An `aria-ref` resolves to the node the last snapshot saw, so looking it up again returns the same dead node; it fails at once like a handle.
- The re-lookup only follows a detached element. A click that went out is never repeated: `ElementDetachedError` is thrown only by the actionability check, before the click is dispatched.
- Tern and cmux already resolve the selector on every attempt, so this is Chromium (managed, relay and connected tabs) only.

## Testing

`bun test test/tools/browser-interactions.test.ts test/tools/browser-upload-chooser.test.ts` in `packages/coding-agent`, headless Chromium on macOS: 51 pass. The new cases use a page that rebuilds a button the click scrolls into view, so the resolved handle is detached first.

- `looks a selector up again when the page replaces its element …`: `tab.click`, `text/`, `frame.click` and a replaced handle. With the source change reverted it fails with `tab.click("#vol") timed out after 8000ms; the element never became clickable (last check: detached (the page replaced this element; look it up again); selector matches 1 element(s))`, the same error the benchmark runs hit. With only `frames.ts` reverted, `frame.click` fails at once.
- `looks the trigger up again when the page replaces it …` (`uploadFile`): fails with the source change reverted.
- A replaced element that is then removed reports "selector currently matches no elements"; `withLiveElement` unit tests cover the replacement refusal, the lookup's own error and the no-retry path.

`bun run check:types` passes; oxlint and oxfmt are clean on the changed files.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
