## What

I kept seeing agents told to reopen a dead tab with an `action:"open"` that hasn't existed since the browser moved into Eval, so the error now names the call that works.

A browser call on a tab that is not open said `Open it first with action:"open".`; it now says the tab was never opened or has been closed since, and to open it with `browser.open({ name: "x" })` (Python: `browser.open(name="x")`), passing the `url` and `app` it was opened with.

## Why

Browser use moved from a `browser` tool with `action`s into Eval's `browser` object, and this message in `runInTabWithSnapshot` (`tools/browser/tab-supervisor.ts`) was missed. An agent following it has nothing to call. Naming `app` matters because `browser.open({ name })` alone uses the settings default: a relay, CDP-attached or adopted Tern tab would come back as a different kind of tab. Python's `browser.open` takes keyword arguments only, so the message names both forms.

I also searched the rest of the browser tool (helpers, preludes, prompt, docs, cmux and Tern backends) for model-facing text naming removed actions or helpers and found none; the `Action 'run' requires…` guards describe the host API both preludes call, not a removed one.

## Testing

- Live, through real JS and Python Eval cells: `await browser.tab("nope").title()` now fails with the new text in both (on `main`: `Open it first with action:"open".`).
- `bun test test/tools/browser-schema.test.ts`: a call on a tab that is not open names both `browser.open` forms and no `action:`; it fails on `main` with the old text.
- `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
