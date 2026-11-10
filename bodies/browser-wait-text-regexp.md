## What

I made `tab.waitForText` accept a `RegExp` the way `tab.waitForUrl` already does, because agents pass one and got a JavaScript `TypeError` instead of a wait.

`tab.waitForText(/Total: \$\d+/)` now waits until the pattern matches the page's trimmed text (or the `selector` element's) on Chromium, Tern and cmux. A string waits as before, and `exact` still applies to strings only. On `main` a pattern threw `TypeError: Argument to String.prototype.includes cannot be a RegExp` on Chromium and cmux, and on Tern it reached the page as `{}` and failed there. A timed-out pattern is named by its source: `tab.waitForText(/never appears/g) timed out after 150ms`, where `main` wrote `tab.waitForText({})`.

## Why

The prelude already sends a `RegExp` across the tool bridge for `waitForUrl`, `waitForResponse` and `tab.run` args, so a pattern reached `waitForText` intact and broke on its first comparison. In a Browser Use benchmark task the agent's `await tab.waitForText(/cart|added/i)` after an Add to Cart click threw, and its next cell dropped the wait for a snapshot.

Shape of the fix:
- `waitForTextMatches` and `waitForTextLabel` in `queries.ts` serve Chromium and cmux. A value is a pattern when its class tag says `RegExp`, so one built in the run's runtime counts too; any other value is compared as on `main`.
- Tern's page kit gets the pattern as its `source` and `flags` and builds it in the page, so the same pattern gives the same answer on every backend.
- A global or sticky pattern a run reuses is tested from the start of the text on every poll.

## Testing

- `bun test --timeout 60000 test/tools/browser-queries.test.ts`: a pattern sent in the prelude's encoding resolves, a reused `/hello/gi` resolves twice, a timed-out pattern is named, and the Tern kit matches `gi` patterns, refuses a sticky one that does not start the text, and refuses a miss, all on a real Chromium page. `bun test test/tools/browser-tern-tab.test.ts`: Tern sends a pattern as `{ source, flags }` and a non-string target as `main` did. With the source change reverted, the queries case fails with `Argument to String.prototype.includes cannot be a RegExp` and the Tern case sends `{}`.
- Not run: a model sample set. A string target behaves exactly as on `main`, so only sessions that pass a pattern see a difference, and on `main` those all failed.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
