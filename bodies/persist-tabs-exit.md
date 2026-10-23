## What

When the agent opened a page in my Chrome with `persist: true` and told me it had left it open for me, the page was gone as soon as `omp -p` exited, so now the end of a session lets go of those tabs instead of closing them.

Reproduced with `omp -p` opening one `persist: true` relay tab and one plain one: after exit Chrome holds neither on `main`, and the persist tab with this PR.

| At session end (`omp -p` exits, a subagent finishes) | main | this PR |
|---|---|---|
| `persist: true` tab omp opened through the relay | closed | left open; omp detaches from it |
| any other tab omp opened through the relay | closed | closed |
| `persist: true` tab in managed Chromium, a spawned app, Tern or cmux | closed | closed |
| `browser.close` on a persist relay tab, also while the session is ending | closes it | closes it |

**Maintainer decision:** `persist` on a relay tab now means "keep this page for the user after the session". On `main` it only opted out of settle-freeze and idle-close, which never apply to relay tabs, so there it did nothing. A new option was the alternative; the model already passes `persist` for this, and the prompt now says to use it on a relay tab only for a page left for the user:

```diff
 … Pass `persist: true` on `open` to keep a tab live across turns (e.g. multi-step login); `browser.close` still releases explicitly.
+Relay tabs are never frozen or idle-closed, and those omp opened close when the session ends; `persist: true` on one leaves it open in the user's Chrome after the session, so pass it there only for a page you leave for the user.
```

Reading order: `tab-supervisor.ts` `releaseTabsForOwner` → `releaseTab` → `releaseTabInner` → `tab-worker.ts` `#close`.

## Why

Agents pass `persist: true` when they hand a page to the user: a sign-in waiting for the user's code, documents the user asked for. Session dispose closed every owned tab, so the hand-off was lost and the agent's "I left it open" was false.

- **Only `persist` tabs**, so ordinary opens still close and the tab litter #16119 removed stays gone.
- **Only relay tabs.** Connected (`cdpUrl`) tabs are always borrowed and already stay open; managed Chromium and spawned apps are omp's to close, and Tern and cmux tabs live in omp's own surfaces.
- A kept page's upload staging waits for the sweep, as a borrowed page's does.
- Non-goals: keeping the tab's omp name for a later session; tabs of a crashed omp; tabs of a session left by `/new` (never released on `main`).

## Testing

- `browser-relay-tab-isolation.test.ts`, real relay extension in Chromium: a session owning a persist and a plain tab ends (`releaseTabsForOwner(owner, { kill: true })`, as dispose runs it); the persist tab is still in Chrome at its URL and gone from omp's tab map, the plain one is closed. Fails with the supervisor change reverted (`No tab with id`). A second test closes a persist tab while its session is ending; it fails if the join keeps `keepPage`.
- `browser-freeze-settle.test.ts`: a persist tab in omp's headless Chromium still closes at session end.
- Live: relay plus headless Chromium with the real extension on a spare port, then `omp -p --model haiku` from this branch opening `keep` (persist) and `drop`. Chrome's tabs after exit: `["about:blank", ".../keep"]`; source reverted: `["about:blank"]`.
- `bun test` of five `browser-*` files around this path: 156 pass, 1 skip. `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
