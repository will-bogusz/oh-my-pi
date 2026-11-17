## What

I kept seeing agents hand-write `evaluate`-and-sleep loops, or pass a function to `tab.waitFor`, to wait for something in a page, so tabs and frames now have `waitForFunction`.

```js
await tab.click("#generate");
const result = await tab.waitForFunction(() => window.__job?.status === "done" && window.__job.result, { timeout: 15_000 });
```

It polls a function (called with any extra arguments) or a string holding an expression or a function (Python passes strings) every `polling` ms (default 100; 200 on cmux) until it is truthy, and resolves with that value. It takes its timeout in ms within the call's budget and fails with `tab.waitForFunction() timed out after 15000ms`. `waitFor` and `waitForSelector` given a function or a number now name the call and the helper to use (`tab.waitFor(1000) waits for a selector string, not a number of milliseconds. …`); on `main` both gave a hint about clicks.

## Why

The direct tab API had no predicate wait (only Puppeteer's `page.waitForFunction` inside `tab.run`), and `waitFor` takes only a selector. In Will's sessions from 2026-10-15 to 2026-11-10, agents wrote 106 polling loops by hand and tried `waitFor(fn)` or `tab.waitForFunction` 32 times, failing 16.

Shape:
- `waitForPagePredicate` (`tools/browser/queries.ts`) runs one page-side wrapper in the frame's main world, where `tab.evaluate` runs. It decides truthiness in the page, so a truthy value JSON cannot carry (a node, a cyclic object, a symbol, a bigint) resolves with `true`. It polls on a timer, which background tabs run, waits out a navigation, and fails on a throw.
- Tern and cmux tabs serve `tab.`/`frame.waitForFunction` with the same labels and the same page-side wrapper, so that `true` holds on every backend. Limit: cmux evaluates synchronously, so a predicate returning a Promise fails there with cmux's existing error; the docs say so.

## Testing

- `bun test test/tools/browser-queries.test.ts test/tools/browser-nav-frames-dialogs.test.ts test/tools/browser-tern-tab.test.ts` (the first two on real headless Chromium): a value from a page timer, function strings with arguments, a cyclic value, a named timeout and exception, the `waitFor` messages, a frame wait, a wait across a navigation, and a Tern frame's predicate, whose sent wrapper the test runs on a cyclic value. All four new tests fail with the change reverted. cmux's wrapper was run in Bun (values, statements, cyclic, function, Promise, throw); no cmux daemon ran.
- Headless sessions at low thinking, `main` vs this branch's first commit (before review added extra arguments and function strings to the prompt line), 4 per arm, scored from transcripts. Task: click Generate, wait until `window.__job.status` is "done", report the result.

  | model | answered | waited on the condition | failed cells | median time |
  |---|---|---|---|---|
  | GPT-6.1 Sol, `main` / branch | 4 / 4 | 3 / 4 | 6 / 0 | 52 s / 20 s |
  | Haiku 5.5, `main` / branch | 4 / 4 | 0 / 3 | 1 / 4 | 19 s / 17 s |

  On `main`, Sol tried `tab.waitFor("window.__job.status === …")` and `page.waitForFunction` in `tab.run`, which timed out; with the branch each called `tab.waitForFunction` once.
- `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

