## What

When a page omp was driving opened a link in a new tab or a popup, Chrome put it in front of the tab I was reading (or handed it my keyboard focus), and omp couldn't even see it; now the popup belongs to omp's tab, my tab and my Chrome window's focus stay where they were, and omp can drive the popup.

| popup from omp's relay tab | before | this PR |
|---|---|---|
| `target=_blank` link, `window.open(url)` | new tab is selected in place of the user's tab; not attached, no `popup` event | attached and owned by omp's tab (`openerId`, `popup` event); the user's tab is selected again |
| sized `window.open(…, "width=…")` | new popup window, not attached; when the user is in Chrome it takes the keyboard focus | owned; the focus goes back to the user's window, the popup stays open behind it |
| omp screenshots, clicks, types in the popup | unreachable | works while the popup is unselected |
| popups from tabs omp does not drive, tabs the user opens | untouched | untouched |
| relay extension installed before this PR | — | popups stay unowned, as before (reinstall for ownership) |

Reading order: `extension/background.ts` → `popup-placement.ts` → `relay/bridge.ts` → `tab-worker.ts`.

## Why

> **Relay context.** The relay attaches only tabs a client opened or claimed, so a popup is a new, unclaimed tab. Chrome's `webNavigation.onCreatedNavigationTarget` names the tab (any frame) that opened it, `noopener` links included.

- **Provenance from Chrome, not timing.** A popup goes to its opener's owners only when Chrome names the opener; a guess from `Page.windowOpen` timing attached a tab the user opened at the same moment.
- **Each popup undoes only what it displaced**, and only while the window's selection count is unchanged, so a tab the user picked meanwhile is never overridden; chained popups resolve to the user's tab.
- **Popup windows stay where Chrome put them.** A minimized one stops rendering (omp's screenshot and click timed out), and Chrome refuses to move one off screen. If it took the focus from one of the user's Chrome windows, focus goes back there, past any popup windows that took it in between (also across a brief no-focus report on Linux); from another app, nothing is focused.
- **Focus emulation on popups and their own popups**, as for omp's own background tabs, so an unselected popup renders and takes input; a popup's popup is owned even before omp has attached to the first. Stale reports expire on tab close, reconnect, or after 10 s.
<details><summary>Maintenance and the known limit</summary>

- **Maintenance.** One new extension permission (`webNavigation`); CHANGELOG and README say to reinstall. An older extension sends no reports and is never asked to background anything.
- **Known limit:** when the user is in another app, Chrome makes itself the active app as it creates the new tab or window, 40-50 ms after omp's click and before the relay acts (15/15 on both branches below); this PR does not hand the app back.

</details>

## Testing

Live, headless (isolated Chrome for Testing with each branch's extension, a user tab selected), through omp's `acquireTab`/`runInTab`, n=5 runs per arm; each run clicks a `_blank` link, `window.open(url)`, a sized `window.open`, and a button opening two.

| | before (858199de15) | this PR |
|---|---|---|
| popup attached to omp / `popup` event | 0/20 / 0/15 | 20/20 / 15/15 |
| user's tab still selected after a tab popup | 0/15 | 15/15 |
| omp screenshots, clicks and types in the popup afterwards | 0/20 | 20/20 |

Live, visible (macOS 26.5 VM, Chrome for Testing 150), n=5 per trial, the user's tab selected in their Chrome window:

| user in their Chrome tab | before | this PR |
|---|---|---|
| `_blank` link, `window.open(url)`: user's tab visible and focused afterwards | 0/10 | 10/10 |
| sized popup window: user's window in front with the keyboard focus | 0/5 | 5/5 |
| omp screenshots, clicks and types in the popup | 0/15 | 15/15 |

| user in TextEdit | before | this PR |
|---|---|---|
| `_blank` link, `window.open(url)`: user's tab still selected in Chrome | 0/10 | 10/10 |
| omp screenshots, clicks and types in the popup | 0/15 | 15/15 |
| Chrome became the active app (frontmost-app watcher) | 15/15 | 15/15 |

An instrumented build showed Chrome activating before any extension call (n=15); a first run before this change activated 7/15.

<details><summary>Regression tests (each fails with its fix reverted)</summary>

- `browser-relay-popup-placement.test.ts` (fake Chrome): user switches mid-lookup, chained popups in both orders, focus handed back before/after Chrome reports it and before any focus was known, every case where the user moved on; each fails with its guard removed.
- `browser-relay-tab-isolation.test.ts` (real extension): `_blank`, `window.open`, sized popup and a cross-site frame's link are owned, put back, then screenshotted, clicked and typed into with the user's tab and focus unchanged; fails with the old minimize or without focus emulation.
- `browser-relay-bridge.test.ts`: provenance in both orders, departed owner, older extension, stale reports; each fails without the fix.

</details>

- The `browser-relay-*` files (popup placement included) and `browser-background-input`: 237 pass; `bun check` passes. Without this change, the five popup tests in `browser-relay-bridge` and `browser-relay-tab-isolation` fail.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




