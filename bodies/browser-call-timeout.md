## What

I kept watching agents set a 300 s timeout on an Eval cell and still have their `tab.evaluate(…)` die at 30 s, so browser calls that set no timeout now take the cell's.

A direct helper such as `tab.evaluate(…)`, and a `tab.run(fn)` without its own `timeout`, ran out at 30 s however long the cell's `timeout` was; it now runs as long as the cell's `timeout` (300 s for a cell with `timeout: 0`), still capped at 300 s and by `tools.maxTimeout`, and never less than 30 s.

| | `main` | this PR |
|---|---|---|
| `tab.evaluate(…)` taking 35 s in a cell with `timeout: 40` | fails at 30 s | returns at 35 s |
| a call that runs past its budget | `Browser code execution timed out after 30000ms` | same error, plus that omp reattached the tab to a new worker and what that reset, and to raise the cell's `timeout` or pass `timeout` to `tab.run` |
| a call with its own `timeout`; `open`, `close`; a cell shorter than 30 s; calls from outside a cell | unchanged | unchanged |

Reading order: `EvalPreludeContext.cellTimeoutMs` (`eval/preludes.ts`), filled by both Eval bridges (`PendingRun` in `eval/js/context-manager.ts`, `registerPyToolBridge` in `eval/executor-base.ts`), then `tabCallBudgetSeconds` (`tools/browser/tab-call.ts`) and its use in `invokeBrowser`, then the messages in `runInTabWithSnapshot` (`tools/browser/tab-supervisor.ts`).

## Why

Eval suspends the cell's watchdog while a browser call runs, because browser calls own their deadlines. But a direct helper reaches the host as a `call` with no timeout of its own, so it got the browser tool's 30 s default, and `tab.evaluate` has no options slot to pass one (its trailing arguments go to the page function). The cell's `timeout` is the only budget the caller gave, so the call now uses it.

Decisions:
- `run` gets the same rule, since it is page work under the same deadline; its own `timeout` still wins.
- The cell's timeout raises the budget but never lowers it below the 30 s default, so short cells keep `main`'s behaviour.
- Kept `main`'s recovery: a timed-out call still reattaches the tab to a new worker, and a worker that does not stop within the grace is still released with its tab. Only the error text now says which happened and how to give long work more time.

Non-goal: Puppeteer's 60 s per-command protocol timeout, which one raw `page.evaluate` inside `tab.run` can still hit.

## Testing

- Live, headless Chromium, through a real JS Eval cell with `timeout: 40`: a 35 s `tab.evaluate` returned at 35.0 s (on `main` it failed at 30.0 s), a never-settling one failed at 40.3 s with the new message, and a page global set before it was still there afterwards.
- `bun test test/tools/browser-schema.test.ts test/eval/prelude-runtime.test.ts test/tools/browser-shared-wedge.test.ts`: the budget `runInTab` gets for `call` and `run` (cell timeout, `timeout: 0`, own timeout, a wait's timeout, no cell, `close`), real JS and Python cells handing the prelude their timeout, and the reason a killed tab reports next. With the `src` change reverted, 6 fail.
- Haiku 5.5 (low), 4 headless sessions per arm, task "call `window.computeReport()` (about 45 s) and report its total": all 8 answered correctly. On `main` 3 wrapped the call in `tab.run(…, { timeout })` and 1 hit the 30 s timeout first; with this PR all 4 called `tab.evaluate` directly in a 120–180 s cell and finished in one cell.
- `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
