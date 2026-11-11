## What

I wanted the browser tool to tell the agent when its click opened something on screen the page can't answer, like a `<select>` menu, a colour picker or a passkey sheet, and hand it that window for the computer tool.

On macOS, visible managed/spawned browsers and a loopback relay now name native windows raised over the tab, with the id `computer.window(id)` takes. A window appearing within 2 s after a call returns is named by the next call; failed calls carry the same notices. Connected CDP endpoints and remote relays are excluded.

| pre-review visible Chrome checks; n=5 managed + 5 relay per arm | on screen | named before | named here, and `computer.window(id)` is that window |
|---|---|---|---|
| `<select>`, colour input, date `showPicker()` | menu or picker 30/30 | 0/30 | 30/30 |
| notification or geolocation permission | bubble 16/20 (Chrome stopped asking the 5th time) | 0/16 | 16/16 |
| passkey `credentials.create()` | sheet 10/10, takes focus from the user's app on both | 0/10 | 10/10 |
| plain button, `fill` | nothing | 0/20 | 0/20 |
| `confirm()` | Chrome's dialog 10/10 | 0/10 (`tab.dialog()` reports it) | 0/10, left to `tab.dialog()` |
| another app's window opening over the tab during each call | 100/100 | 0/100 | 0/100 |

## Why

Before, these windows appear while the call reports success. Read `roster.rs`, `native-windows.ts`, then `tab-worker.ts`.

- The tab's current frame and visibility come from an isolated world, rechecked at the after-call and tail samples. A known browser pid restricts matching; ambiguous matches and popups overlapping another browser window are suppressed.
- Windows are sampled in one window-server pass. Only never-seen windows of the tab's browser count; macOS-owned prompts and the page's own JavaScript dialogs remain outside this report. Normal-window candidates matching browser page targets (such as OAuth popups) are excluded; an unreadable page-frame probe suppresses normal-window reports.
- The report is always on for supported visible browsers. Pre-review measurements added 27–35 ms median per call; headless and connected-CDP calls skip it.

Non-goals: answering windows; Linux and Windows. Untested: a user's window opening inside the tab's frame mid-call; `print()`. Merged #18838 disables printing in omp's Chrome profile, not attached browsers.

Known limits: a picker in a background tab isn't named. Native tooltip windows may meet the popup geometry filter and be reported as panels/pickers even when their text is in the DOM; distinguishing those needs native role metadata beyond this roster. Tooltip behavior has not been reproduced in the headless-only review checks.

## Testing

`bun test packages/coding-agent/test/tools/browser-native-windows.test.ts` on bench-mac exercises real isolated headless Chrome plus fake rosters: 26 tests pass, including page-global overrides, page-backed popups, tab moves, visibility switches, overlapping windows, and unterminated stdout. Behavior regressions fail before their fixes; page-global overrides also disprove the claimed main-world exposure in the pinned Puppeteer patch. `bun check --no-script -p packages/coding-agent/tsconfig.json` passes.

<details>
<summary>Earlier visible-browser evidence</summary>

macOS 26 VM, Chrome for Testing 150, TextEdit frontmost; arms `af86757741` and pre-review `c43fc6560d`. Calls waited 700 ms after clicks so TextEdit's window showed mid-call; its windows were never named (0/100). Without the wait, permission bubbles and passkey sheets were mostly named by the next call. Switching to another tab before a call changed false menu reports from 5/5 to 0/5; menus were still named with TextEdit covering Chrome (15/15).

The original 18 fake-roster tests passed, as did `cargo test -p pi-natives --lib` (904 tests) and `bun check` on that revision. No Linux/Windows live check; this report is macOS-only.

</details>

---

- [ ] `bun check` passes (main's unrelated formatting failure remains; targeted package typecheck passes)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




