## What

A failed JavaScript cell was mostly omp's own stack trace, so I cut it down to the message and the frames from the cell itself.

Across 892 recorded browser-task errors the printed error goes from a median of 239 tokens to 113:

```text
main:
ReferenceError: document is not defined
    at <anonymous> (browser-run-15c8ff3b64dae842.js:2:68)
    at <anonymous> (browser-run-15c8ff3b64dae842.js:2:78)
    at <anonymous> (browser-run-15c8ff3b64dae842.js:3:3)
    at eval (unknown)
    at <anonymous> (/…/packages/coding-agent/src/eval/js/shared/runtime.ts:556:14)
    at async run (/…/packages/coding-agent/src/eval/js/shared/runtime.ts:551:27)
    at browser.run (js-cell-63b7dcc0-aae1-4e83-950f-cbf3f029c9e3.js)

this PR:
ReferenceError: document is not defined
    at <anonymous> (browser-run-15c902fd19c414f1.js:2:46)
    at <anonymous> (browser-run-15c902fd19c414f1.js:2:53)
    at <anonymous> (browser-run-15c902fd19c414f1.js:3:3)
    at browser.run (js-cell-bc21af73-74d0-45d1-8029-9a04e256dbe6.js)
    (3 omp frames hidden; catch the error and print e.stack to see them)
```

Hidden: frames in the tree omp's code runs from (its source and dependencies such as puppeteer), a compiled build's `$bunfs`, preludes and engine internals. Kept: everything else, including a `%load`ed file and the user's modules.

## Why

A helper failure such as a `tab.click` timeout carried up to a dozen frames from `tab-worker.ts`, `runtime.ts`, puppeteer or `$bunfs` chunks, resent with every later request of the run; the model cannot act on any of them.

- Only the printed text changes (`formatCellError` in `executeJs`). `error.stack` stays whole: the worker reads it to tie a rejection to its cell, and a cell that catches the error still sees every frame.
- omp's tree comes from the module's own location, not `PI_PACKAGE_DIR`, which names an asset folder. With the working directory inside that tree (working on omp itself), frames under it count as the user's.
- The catch hint appears only when the stack names the cell; a worker exit, which no cell can catch, gets just the count.

Non-goals: cell line and column numbers, late-rejection notices (3 of the 892), Python tracebacks.

## Testing

- `test/eval/js-error-text.test.ts`: a throwing cell prints only its own frames and the hint (fails with `executor.ts` reverted); a file cell inside omp's tree keeps its frames; `process.exit(3)` gets no hint; `PI_PACKAGE_DIR=/opt/omp` hides no user frame. Each fails with its rule removed.
- Live (headless Chromium, `executeJs`): selector timeout, cell `ReferenceError`, `tab.run` error, page-side throw, worker exit.
- Replaying the 472 bench runs with their recorded usage: 1.2% fewer input tokens, 1.8% lower cache-weighted input cost. No model run: in those runs no model ever named a hidden frame's file afterwards.
- Not run: Windows (`\` paths); a mismatch there hides nothing, as on `main`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
