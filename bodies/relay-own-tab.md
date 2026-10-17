## What

An agent opening a relay tab without naming one kept grabbing the tab I was reading and navigating it away, so now it opens its own tab in the background and closes it when it's done.

| | main | this PR |
|---|---|---|
| relay open, no `app.target` | adopts the selected tab; `url` navigates it away | opens a new unselected tab; the user's tab, selection and window focus are untouched |
| click, type, screenshot on it | (the user's tab) | work in the background; screenshots never raise it |
| `browser.close` | releases; the tab stays | closes omp's tab, also after a forced release, a force-kill, or the user dismissing its debugger bar |
| `app.target` | borrows a tab; close leaves it | unchanged |
| two browsers on one relay | new tabs follow the last extension hello | the browser of the tab omp used last on that relay, else the one showing the first selected tab, else the last hello |

**Maintainer decision: this changes the relay default.**

Reading order: `tab-protocol.ts` (`page: create | owned | borrowed`) → `tab-supervisor.ts` `buildInitPayload`, `ownsPage` (replaces `main`'s `reattached`), `closeTargetById` → `orphan-registry.ts` `closeRelayTarget` → `tab-worker.ts` `#init` → `relay/bridge.ts` `#instanceForNewTab` (`nearTargetId`).

## Why

- **Default, not opt-in.** The tool prompt already forbade navigating the visible tab unasked, yet the default path did; an opt-in (#12582, #11662) misses every call that forgets the flag.
- **Screenshots.** The owned tab is focus-emulated, so Chrome captures it without activation; borrowed tabs keep `main`'s activate-before-capture.
- **Older extension.** One predating #15109 opens the tab selected but never navigates the user's page; refusing it would break relay users until they reinstall.
- **Which browser.** New tabs followed the last hello, which flips when a service worker restarts. Each omp tab has its own relay connection, so the supervisor names the tab it used last (`nearTargetId`, a relay-only parameter); a page session's create still opens in that page's browser. Known limit: the fallback doesn't probe `visibilityState`, so a minimized browser listed first beats a visible second one.
- With no relay browser target, create and close use Puppeteer's root connection.
- **Upload staging** now goes with any page omp owns and closes (owned relay tabs too, not only headless).
- Non-goals: advisory claims; freezing or idle-closing owned relay tabs; closing a crashed omp's tabs; `app.cdp_url` still adopts.
- Takes over #14060 by nnnnoel (co-author), without its close refusal for borrowed tabs. Related: #12101, #12314, #14881, #14865. Refs #14884, #11688, #12049.

## Testing

- `browser-relay-tab-isolation.test.ts` (real extension in Chromium): a relay open with a `url` and no `app.target` leaves the selected tab where it is; on `main` that test fails, as the open adopts the selected tab and navigates it to the `url`. The others: own tabs unselected, user tab untouched, click works, close removes the tab, borrowed tab survives, dismissed-debugger tab closed, owned recovery target survives a failed init, a second browser's default tab opens beside the tab borrowed there; 4 of 5 fail with the source reverted. Bridge tests: routing fails without `#instanceForNewTab`; an offline browser's tab reported closed fails with `main`'s check.
- The isolation test also hovers the unselected owned tab; without focus emulation that hover times out.
- `bun test test/tools/browser-*.test.ts`: 633 pass, 4 skipped; the 10 failures, all in `browser-run-listeners.test.ts`, fail the same on `main` on this host. `oxlint`, `oxfmt --check` and `check:ts` pass.
- Live, headful Chrome for Testing on an isolated relay, user tab selected, via `acquireTab`/`runInTab`/`releaseTab`:

| extension | user tab after open | owned tab | click | screenshot | close |
|---|---|---|---|---|---|
| this branch | selected | unselected | `clicked` | captured, nothing raised | owned gone, borrowed kept |
| from before #15109 | deselected | selected | `clicked` | captured | owned gone, user tab reselected |

Frontmost app never changed. Two browsers: the owned tab stayed in browser 0 across each extension reconnecting; after borrowing a tab in browser 1, a default open landed there (browser 0 before `nearTargetId`).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




