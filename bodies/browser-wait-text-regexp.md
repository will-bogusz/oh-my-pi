## What

I made `tab.waitForText` accept a `RegExp` the way `tab.waitForUrl` already does, because agents pass one and got a JavaScript `TypeError` instead of a wait.

`tab.waitForText(/Total: \$\d+/)` now waits until the pattern matches the page's trimmed text (or the `selector` element's) on Chromium, Tern and cmux. A string waits as before, and `exact` still applies to strings only. On `main` a pattern threw `TypeError: Argument to String.prototype.includes cannot be a RegExp` on Chromium and cmux, and on Tern it reached the page as `{}` and failed there. A timed-out pattern is named by its source: `tab.waitForText(/never appears/g) timed out after 150ms`, where `main` wrote `tab.waitForText({})`.

## Why

The prelude already sends a `RegExp` across the tool bridge for `waitForUrl`, `waitForResponse` and `tab.run` args, so a pattern reached `waitForText` intact and broke on its first comparison. In a Browser Use benchmark task the agent's `await tab.waitForText(/cart|added/i)` after an Add to Cart click threw, and its next cell dropped the wait for a snapshot.

Shape of the fix:
- One page-side test, `pageTextMatches` in `queries.ts`, serves all three backends (Chromium's isolated world, cmux by source, Tern's kit embeds it). A pattern reaches the page as `source` and `flags`, so every backend answers alike and a reused global or sticky pattern is tested from the start each poll. A value is a pattern when its class tag says `RegExp`, so one from the run's runtime counts too.
- The pattern runs in the page, not omp: in omp's tab worker (in-process on cmux) a backtracking match is synchronous and ran past the deadline, `/a*a*b/` on 10,000 characters for 46 s in Bun. Each poll's page call is raced against the wait's remaining budget on every backend, so the wait ends at its timeout. Limit: the page stays busy until the match ends, so the tab's next call waits too.
- The prompt now teaches the string/`RegExp` contract and that `exact` is string-only.
- On a Tern with native DOM reads, a string `waitForText` can run up to 5 s past its requested timeout (reply grace, clamped to the cell budget).

## Testing

- `bun test test/tools/browser-queries.test.ts`, on real Chromium: a pattern in the prelude's encoding resolves, a reused `/hello/gi` resolves twice, a timed-out pattern is named, and the Tern kit matches `gi`, refuses a sticky pattern that does not start the text, and refuses a miss. `browser-tern-tab.test.ts`: Tern sends a pattern as `{ source, flags }`. Reverted, the first fails with `Argument to String.prototype.includes cannot be a RegExp` and Tern sends `{}`.
- Probes, `/a*a*b/` on 3,000 characters, `timeout: 300`, body and scoped: Chromium returned at 304 ms (1.4 s with the match in the worker); cmux over a Chromium page as the surface at ~300 ms (4.1 s before the race); Tern's fake daemon with a 3 s kit answer at ~300 ms (before, the late answer resolved the wait at 3 s). Only wall-clock time shows this, so no test pins it.
- Not run: a model sample set. A string target behaves as on `main`; only sessions passing a pattern differ, and on `main` those all failed.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

