## What

omp kept telling me it clicked something on a tab I had in the background when the page never got the click, so tabs I lend it now count as visible while it drives them and go back to hidden when it lets go.

In a benchmark task that submits a two-page form in a borrowed background tab (GPT-6.1 Sol, this PR merged with other queued browser fixes), median steps went from 13 to 8: on `main` the review page's Submit click fails as "did not deliver the click to the element (disabled or inert)" on a button that is neither, and type, press and fill report success while the page gets nothing.

In relay and `app.cdp_url` mode, a page omp borrows (`app.target`) or adopts can sit in an unselected tab, or in a window another window covers on macOS, which Chrome treats as hidden. Chrome holds back input to a page until it has drawn, and a hidden page never draws, so a borrowed page that loaded in the background, or navigated there (a form's Next), drops trusted input. Since #16119, tabs omp opens itself already count as visible; this PR covers the tabs it borrows.

| background tab omp borrows (relay `app.target`; headful Chrome 150) | main | this PR |
|---|---|---|
| never selected | click fails: "did not deliver the click to the element (disabled or inert)"; type, press and fill report success, but the page gets none of it; hover and drag time out after 8 s | all six reach the page |
| selected before, then the user moved on | click, type, press and fill work; hover and drag time out | all six reach the page |
| selected before, then it navigated in the background | as never selected | all six reach the page |
| the user's selected tab and the frontmost app | unchanged | unchanged |
| the page after `browser.close` | hidden | hidden |

**What the page can observe:** while omp drives it, the page reads as visible (`document.visibilityState`), as omp's headless pages already do; released, it reads hidden again.

Reading order: `tab-worker.ts` `#init` (emulate focus when `payload.userDriven`) → `relay/bridge.ts` `TAB_WIDE_SWITCHES`, `#releaseSwitches`.

## Why

It widens the bridge's per-tab file-chooser switch into a table that also holds focus emulation.

- **Cause.** `main` emulates focus only on pages omp owns: its own browsers and, since #16119, the relay tabs it opens (`ownsPage`). `Emulation.setFocusEmulationEnabled` makes Chrome count a page as visible without selecting its tab or raising the window.
- **Decision.** `ownsPage`'s doc says a borrowed tab is never focus-emulated (#16119); this reverses that for connected and relay browsers. Selecting the tab per action would take it from the user.
- **Release.** Chrome ends a client's emulation with its session, which covers `app.cdp_url`. Relay clients share the tab's one debugger session, which outlives them, so the bridge keeps each switch on while any session asks, turns it off when the last one stops, detaches or disconnects (a killed worker too), turns both back on after a service-worker restart, and on hello resends what a dropped extension socket or relay restart left unknown.
- #12314 saw focus emulation drop the relay's debugger on a TanStack Router app; driving tanstack.com/router here kept it.
- Non-goals: Electron apps are unchanged.

## Testing

- `browser-background-input.test.ts` (headless Chromium; real relay extension, and `app.cdp_url`): a hidden background tab takes hover and click through omp, the user's tab stays selected, and the page reads hidden after release, including after a second named tab's release and a killed worker. Its 4 tests fail on `main` (hover times out), as do the 5 new `browser-relay-bridge.test.ts` focus-emulation cases.
- The table: headful Chrome 150 on Linux (Xvfb) through the real relay extension, each action checked against a page-side event log, on `main` 0b5c27ab24 and on this PR's commits replayed onto it (2026-10-23). Headless Chromium cannot show the click and key rows: it lets input through before a page draws.
- Headful Chrome in a macOS VM via the relay, the first two rows (2026-10-13, before #16119): trusted events reached the page in 8 of 18 actions on `main`, 18 of 18 with this PR.

Not run: headful Chrome on Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
