## What

omp kept telling me it clicked something on a tab I had in the background when the page never got the click, so the pages it drives in my Chrome now count as visible while it drives them and go back to hidden when it lets go.

In relay and `app.cdp_url` mode, a page omp borrows (`app.target`) or adopts can sit in an unselected tab, which Chrome treats as hidden.

| background tab omp drives (headful Chrome) | main | this PR |
|---|---|---|
| never selected | click, type, press and fill report success in about 35 ms, but the page gets none of it; hover and drag time out after 8 s | all six reach the page |
| selected before, then the user moved on | click, type, press and fill work; hover and drag time out | all six reach the page |
| the user's selected tab and the frontmost app | unchanged | unchanged |
| the page after `browser.close` | hidden | hidden |

**What the page can observe:** while omp drives it, the page reads as visible (`document.visibilityState`), as omp's headless pages already do; released, it reads hidden again.

Reading order: `tab-worker.ts` `#init` (emulate focus when `payload.userDriven`) → `relay/bridge.ts` `TAB_WIDE_SWITCHES`, `#releaseSwitches`.

## Why

It widens the bridge's per-tab file-chooser switch into a table that also holds focus emulation.

- **Cause.** `main` emulates focus only on omp's headless pages. `Emulation.setFocusEmulationEnabled` makes Chrome count a page as visible without selecting its tab or raising the window.
- **Decision.** The `emulateFocus` doc said "never a borrowed user tab" (9b2a43514b); this reverses that for connected and relay browsers. Selecting the tab per action, as screenshots do, would take it from the user.
- **Release.** Chrome ends a client's emulation with its session, which covers `app.cdp_url`. Relay clients share the tab's one debugger session, which outlives them, so the bridge keeps each switch on while any session asks, turns it off when the last one stops, detaches or disconnects (a killed worker too), turns both back on after a service-worker restart, and on hello resends what a dropped extension socket or relay restart left unknown.
- #12314 saw focus emulation drop the relay's debugger on a TanStack Router app; driving tanstack.com/router here kept it.
- Non-goals: borrowed-tab screenshots still select the tab first; Electron apps are unchanged.

## Testing

- `browser-background-input.test.ts` (headless Chromium; real relay extension, and `app.cdp_url`): a hidden background tab takes hover and click through omp, the user's tab stays selected, and the page reads hidden after release, including after a second named tab's release and a killed worker. Input fails without the `#init` change (hover times out); release fails without the bridge change, as do 6 new `browser-relay-bridge.test.ts` cases.
- `bun test test/tools/browser-background-input.test.ts test/tools/browser-relay-bridge.test.ts test/tools/browser-upload-chooser.test.ts`: 68 pass; `check:types` passes.
- Headful Chrome in a macOS VM via the relay, page-side event log, the cases above: trusted events reached the page in 8 of 18 actions on `main`, 18 of 18 with this PR.

Not run: headful Chrome on Linux or Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
