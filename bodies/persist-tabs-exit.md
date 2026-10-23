## What

When the agent opened a page in my Chrome with `persist: true` and told me it had left it open for me, the page was gone as soon as `omp -p` exited, so now the end of a session lets go of those tabs instead of closing them.

Two benchmark tasks that check a page the agent handed over is still open after `omp -p` exits: 0/2 → 2/2 each.

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

Agents pass `persist: true` when they hand a page to the user: a sign-in waiting for the user's code, documents the user asked for. Session dispose closed every owned tab, so the agent's "I left it open" was false.

- **Only `persist` tabs**, so ordinary opens still close and the tab litter #16119 removed stays gone.
- **Only relay tabs.** Connected (`cdpUrl`) tabs are always borrowed and already stay open; managed Chromium and spawned apps are omp's to close, and Tern and cmux tabs live in omp's own surfaces.
- A kept page's upload staging waits for the sweep, like a borrowed page's.
- Non-goals: keeping the tab's omp name for a later session; tabs of a crashed omp; tabs of a session left by `/new` (never released on `main`).

## Testing

- `browser-relay-tab-isolation.test.ts`, real relay extension in Chromium: a session owning a persist and a plain tab ends (`releaseTabsForOwner(owner, { kill: true })`, as dispose runs it); the persist tab is still in Chrome at its URL and gone from omp's tab map, the plain one is closed. Fails with the supervisor change reverted (`No tab with id`). A second test closes a persist tab while its session is ending; it fails if the join keeps `keepPage`.
- `browser-freeze-settle.test.ts`: a persist tab in omp's headless Chromium still closes at session end.
- Benchmark, GPT-6.1 Sol through the relay, 2 runs per arm: `main` failed both tasks on exactly the closed-tab grade lines; `main` plus this and other queued browser fixes passed all 4.
- Live, Haiku: `omp -p` on a spare relay opens `keep` (persist) and `drop`; after exit Chrome holds `keep` only, and with the source reverted neither.
- `bun test` of five `browser-*` files around this path: 156 pass, 1 skip. `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
