## What

I made a `tab.run` that touches `document` say where its code runs, because agents write page code into `tab.run`, read "document is not defined", and guess at why.

A run whose own code reaches for `document`, `window`, `location`, `history`, `localStorage`, `sessionStorage`, `customElements`, `getComputedStyle`, `CSS`, an `HTML…Element` class, `Element` or `Node` now fails with `ReferenceError: document is not defined: tab.run code runs in omp's Bun runtime, not in the page; run page code with tab.evaluate(() => ...)`. On `main` it fails with `ReferenceError: document is not defined` alone. Other errors are unchanged, including the same `ReferenceError` thrown by a page script.

## Why

`tab.run` runs in omp's Bun runtime with Puppeteer's `page` in hand, but the name reads like "run in the tab". In Will's sessions from 2026-10-15 to 2026-11-10, 5 of the 7 "… is not defined" errors in browser cells came from a page-DOM function handed to `tab.run` (2 of them on 18.16.0), and 4 of 15 Browser Use tasks hit it. Each cost a cell to work out where the code had run.

Shape of the fix:
- `isMissingPageGlobal` in `tab-protocol.ts` decides: a real `ReferenceError` whose message names one of those globals. An exception thrown inside the page reaches the run as a plain `Error` that Puppeteer names after it, so it never counts.
- The worker sets `missingPageGlobal` on the run's error payload, and the supervisor's `runInTab` appends the hint when it revives the error. In-process backends (cmux, Tern) throw the original error, which `runInTab` checks the same way.
- The error keeps its name and stack; only the message gains the sentence.

## Testing

- `bun test test/tools/browser-tab-worker-startup.test.ts`, "says where run code runs when it reaches for a page global, and not when the page throws", on real headless Chromium: `return document.title` gets the hint, an undefined cell variable does not, and a page that deletes its own `CSS` and reads it in `page.evaluate` keeps Puppeteer's error unchanged. With the change reverted the first assertion fails on the bare `ReferenceError: document is not defined`.
- Sample set, Haiku 5.5 and GPT-6.1 Sol, 2 runs each on `main` and this branch, task "read the page title and count custom elements with `tab.run`": no run on either side handed `document` code to `tab.run` (all used `page.evaluate`), so the set shows no difference. The hint only reaches agents who make the mistake.
- `bun run check:types` and `oxfmt --check` pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
