## What

I wanted the browser tool to tell the agent when its click opened something on screen the page can't answer, like a `<select>` menu, a colour picker or a passkey sheet, and hand it that window for the computer tool.

On macOS, in a browser that shows its windows, a call's result now names each window it raised over its tab, with the id `computer.window(id)` takes (`The browser opened a popup list or picker … during this call. … computer.window(5138) (73x82) reads, answers or closes it.`). One that shows within 2 s after the call returned is named by the next call; failed calls carry the lines too.

| agent clicks, visible Chrome; n=5 managed + 5 relay per arm | on screen | named before | named here, and `computer.window(id)` is that window |
|---|---|---|---|
| `<select>`, colour input, date `showPicker()` | menu or picker 30/30 | 0/30 | 30/30 |
| notification or geolocation permission | bubble 16/20 (Chrome stopped asking the 5th time) | 0/16 | 16/16 |
| passkey `credentials.create()` | sheet 10/10, takes focus from the user's app on both | 0/10 | 10/10 |
| plain button, `fill`, `print()` (held) | nothing | 0/30 | 0/30 |
| `confirm()` | Chrome's dialog 10/10 | 0/10 (`tab.dialog()` reports it) | 0/10, left to `tab.dialog()` |
| another app's window opening over the tab during each call | 100/100 | 0/100 | 0/100 |

## Why

Before, these windows appear while the call reports success. Read `roster.rs`, `native-windows.ts`, then `tab-worker.ts`.

- `desktopWindowRoster()` (pi-natives): one window-server pass with owner pid, layer, bounds and `listed` (capture's own predicate: true exactly when `computer.window(id)` resolves).
- The tab's window is the one ordinary window at the page's frame, matched while the page shows (`visibilityState`); two matches mean none. Only never-seen windows of that browser count, only while the page shows: menus over the tab's window, smaller windows inside it.
- Not named: macOS-owned prompts (Touch ID, keychain), which nothing ties to the tab, and the page's own `alert`/`confirm`, which the tab's pending-dialog state reports.
- Cost: +27 to +35 ms median per call (n=50 per arm per browser); headless skips it.
- Maintenance: rests on Chrome drawing menus above normal windows and sheets inside the tab's window; else the report goes quiet, not wrong.

Non-goals: answering the windows; Linux and Windows. Untested: a window the user opens in that browser inside the tab's frame mid-call would be named.

## Testing

macOS 26 VM, Chrome for Testing 150, TextEdit frontmost, a TextEdit window opened over the tab during each call. Managed `headed` tab and a relay tab borrowed by `app.target`; arms `af86757741` (before) and this head `c43fc6560d`. Calls wait 700 ms after the click so TextEdit's window shows mid-call.
- Without the wait (previous head): same counts; TextEdit's window showed after the call, never named (0/100); menus, bubbles (0.6-0.9 s) and passkey sheets mostly showed after the click, named by the next call.
- The user opens a `<select>` in another tab of the same window during omp's call: previous head named it 5/5, this head 0/5. With TextEdit covering the browser window the page still reports visible and its menus are named (15/15).
- 18 fake-roster tests in `browser-native-windows.test.ts` (18 pass); each rule's test fails with it reverted. On macOS, `cargo test -p pi-natives --lib` (904 pass, `listed_is_the_capture_snapshot_rule` included) and `bun check` pass. Not run: Linux, Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)



