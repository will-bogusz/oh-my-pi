## What

I made macOS `press()` and a background `el.click()` refuse a control a person could not click at that moment, before anything is sent, naming what the window shows at its place. I ask the control's own app what a click at its center would reach, and only an answer inside the control's own window is judged, so a window that is covered, on another Space or minimised works as before. A window showing a sheet refuses the controls it draws itself.

## Why

A hover toolbar's buttons leave the accessibility tree once the pointer leaves, but a ref read while they showed still accepts `AXPress`: the app runs the action and the tool reports success for a click nobody could have made. A control the app hid, or one under its window's sheet, does the same.

## Testing

In a macOS 26 guest I ran `main` against this branch, 10 tries per cell, interleaved, with the app's own log as the check:

| Control (my AppKit fixture unless named) | `main` | This PR |
|---|---|---|
| Benchmark app's hover toolbar: button read while shown, pressed after the pointer left | success 10/10; app logs a click with the toolbar hidden | refused 10/10, nothing logged |
| Fixture hover toolbar button, toolbar hidden | success, action ran 10/10 | refused 10/10 |
| Button the app hid, window in front / covered | success, action ran 10/10 each | refused 10/10 each |
| Same, background `el.click()` | success 10/10 each, no action | refused 10/10 each |
| Button of a window showing a sheet, front / covered | success, action ran 10/10 each | refused 10/10 each |
| Button removed / disabled | refused (stale ref / disabled) | same |

In Cua Driver Bench task MB-10 (a toolbar whose buttons show only under the pointer; foreground, GPT-6.1 Sol at medium, 3 trials per build, same seeds):

| Build | MB-10 done |
|---|---|
| v18.20.0 | 0 of 3 |
| `main` 57263720c81 plus five other fix branches, without this fix | 0 of 3: each pressed a button no longer shown and failed the task's `overlay_visible_at_click` check; no refusal |
| the same plus this fix and a background-move note | 3 of 3: each got this refusal at call 4, read or hovered again in the next call, and finished |

The passing build also carries the move note and five other fixes, so the attribution rests on the refusal appearing at call 4 in all three passing trials and in none of the failing ones, not on the build difference alone. On a 96-run pass of our own task set on that build, 96 of 96 passed (graded and strict, no task worse than v18.20.0) and this refusal fired 0 times: those tasks never press a control a person could not click.

Nothing `main` accepted was refused: 1,290 of 1,290 tries across AppKit, SwiftUI, WKWebView, Chrome and Electron, in front, covered, on another Space, minimised, scrolled out of view, and in sheets, popovers and menus. A read-only pass of the rule over real apps walked 1,979 controls. A press costs 0.5 to 2 ms more at the median.

Web content and Chromium apps are not hit-tested, because Chromium answers from a cache that lags the page; a stale web control is still pressed as on `main`.

`cargo test -p pi-natives --lib placement`: 9 tests, one per branch of the rule.

<details><summary>Signal, false-refusal matrix, census, review answers</summary>

How the rule judges an answer from `AXUIElementCopyElementAtPosition` on the control's app, which only looks at that app's windows:
- No answer, or one in another window: not judged (covered, other Space, minimised, the same app's other window).
- The control, a part of it, or something containing it (row, cell, group, window): passes while each step down to the control is still listed under its parent. A hidden AppKit view is no longer listed, which is how a hidden control differs from a label inside its button. A cell drawn inside a listed column passes too.
- A covered center passes when one of four other points reaches the control; a center outside an ancestor's bounds (scrolled out of view) passes.
- Sheet rule, checked first: a window showing a sheet takes no click outside it, yet its controls still hit-test to themselves, so a control the window draws itself is refused; controls drawn by the sheet, a popover or another process (a sandboxed Save panel) and title-bar buttons pass. It applies to web content too.
- `AXRaise`, `AXScrollToVisible` and a takeover `el.click()` are not checked.

Rejected: the control's own attributes (a hidden `NSView` keeps its frame and still accepts `AXPress`); the system-wide hit-test (it answers the window on top, so every covered window would be refused); requiring the hit to be the control itself (rows, cells and groups usually answer for it).

Accepted by `main` / accepted by this PR, every control `main` accepted at least once (`·`: not applicable, or neither build could act):

| Target is | AppKit | SwiftUI | WKWebView | Chrome | Electron |
|---|---|---|---|---|---|
| in front | 40 / 40 | 30 / 30 | 30 / 30 | 40 / 40 | 40 / 40 |
| covered by another app | 40 / 40 | 30 / 30 | 40 / 40 | 40 / 40 | 40 / 40 |
| on another Space | 20 / 20 | 20 / 20 | 20 / 20 | 20 / 20 | 20 / 20 |
| minimised | 30 / 30 | 20 / 20 | 30 / 30 | 20 / 20 | 20 / 20 |
| in full screen | 40 / 40 | · | · | · | · |
| scrolled out of view | 40 / 40 | 30 / 30 | 40 / 40 | 30 / 30 | 30 / 30 |
| in a sheet | 40 / 40 | 30 / 30 | 40 / 40 | 40 / 40 | 40 / 40 |
| in a popover | 40 / 40 | 30 / 30 | 40 / 40 | 40 / 40 | 40 / 40 |
| in a popover from a sheet | 40 / 40 | 30 / 30 | · | · | · |
| a menu item | 10 / 10 | · | 10 / 10 | 10 / 10 | 10 / 10 |

Census, front window then covered by another app: Finder, Notes, Reminders, Calendar, Contacts, Preview, Font Book, Automator, Activity Monitor, System Settings, TextEdit and its Save sheet, Safari, LibreOffice (start centre and a Calc document), GnuCash's tip dialog, Messages and Maps (Mac Catalyst), the fixture and Preview in full screen; every element with area in Finder and Activity Monitor. Refused: only the two limits above.

Cost per press, median of 10, `main` → this PR: AppKit 119.2 → 121.4 ms, SwiftUI 15.7 → 16.5, WKWebView 17.6 → 18.4, Chrome 17.7 → 18.5, Electron 13.9 → 14.4.

An independent review asked for changes, and I made them: the refusal names `el.click({ takeover: true })`; the sheet rule judges by the window that draws the control and exempts title-bar buttons; full screen, the Save sheet, a popover from a sheet and Catalyst apps were probed with nothing refused; the wiring has its own test.

</details>

## Risk

- Limits: Safari's tab-group chevron, shown only under the pointer, is refused for `press()` and a background `el.click()`; a takeover `el.click()` is not checked and is what the refusal names, but under `computer.backgroundFallback: "refuse"` nothing reaches it. A 14-point area under a window's full-screen button is refused for a background `el.click()`, naming the button, which is what a click there hits.
- Not run: SwiftUI and the web targets in full screen, the web targets in a popover opened from a sheet; SwiftUI pickers and menu items (no route works on either build); GnuCash beyond its tip dialog; `bun check`.
- Review first: `placement::require_shown`, the order of its passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

