## What

On macOS, `press()` and a background `el.click()` now refuse, before anything is sent, a control a person could not click at that moment, and name what the window shows at the control's place instead. On the benchmark app's hover-only toolbar, `main` pressed a button that was no longer shown 10 of 10 times and reported success; this PR refuses 10 of 10 and the app logs nothing. Across the fixture matrix (AppKit, SwiftUI, Chrome, Electron and WKWebView pages, in front, covered by another app, on another Space, minimised, scrolled out of view, in a sheet, a popover and a menu) no cell that `main` pressed is refused.

The check asks the element's own application what a click at the element's center would reach (`AXUIElementCopyElementAtPosition` on the application, which hit-tests only that app's windows) and judges only an answer inside the element's own window:

- An answer in another window, or none, is ordinary background work and passes: another app's window on top, another Space, a minimised window, the same app's other window.
- An answer that is the element, inside it, or contains it (its row, cell, group or window) passes as long as each step down to the element is still listed among its parent's children; a hidden AppKit view is not listed, which is how a hidden control is told apart from a label inside its button. An answer drawn inside the frame of a listed element (a column's cell) passes too.
- A center covered while another part of the element still reaches it passes (four more points are tried), and so does an element whose center lies outside an ancestor's bounds (scrolled out of view: the press may scroll it in).
- Web content and Chromium-drawn apps are not hit-tested: Chromium answers from a cache that lags the page (a visible dialog button once hit-tested to the web area), clips a scrolled-out element's frame to a one-point strip, and WebKit routes a check box's label text to the text. A hidden web element leaves the tree anyway.

A window that shows a sheet takes no click outside it, while its controls outside the sheet's frame still hit-test to themselves, so one more rule comes first: an element its window draws itself (not the sheet, a popover or another process, such as a sandboxed app's Save panel) is refused while the window shows a sheet, title-bar buttons excepted. This rule applies to web content too.

`AXRaise` and `AXScrollToVisible` are not checked, nor is a takeover `el.click()`: the pointer it brings first can show a hover-only control, which is the route the refusal names.

## Why

A hover-only toolbar's buttons leave the accessibility tree a moment after the pointer does, but a ref read while they showed still answers `AXPress`: the app runs the action, and the tool reports success for a click no person could have made. An AppKit control the app hid, or one under its window's sheet, behaves the same. A background click at such a place reports success too, while it lands on whatever the window shows there.

Rejected signals: the element's own attributes (an `NSView` its app hid keeps its frame and still answers `AXPress`; a removed element already fails as stale); the system-wide hit-test (it answers the window on top, so covered, other-Space and minimised windows would read as "not shown"); requiring the hit to be the element itself (most controls never answer a hit-test themselves: rows, cells, groups and windows answer for them).

## Testing

Measured in a macOS 26 guest, `main` (6ec2b71) against this branch's addon, 10 tries per cell interleaved, the app's own log as the oracle; the addon was proven loaded by the cells where the two answers differ.

| Control (AppKit fixture unless named) | `main` | This PR |
|---|---|---|
| BenchLab hover toolbar (the benchmark's MB-10): buttons read while shown, pressed after the pointer left | success 10/10; the app logs a click with the toolbar hidden 10/10 | refused 10/10, nothing logged |
| Fixture hover toolbar button, toolbar hidden | success, action ran 10/10 | refused 10/10, no action |
| Button the app hid, window in front / covered | success, action ran 10/10 each | refused 10/10 each, no action |
| Same, background `el.click()`, front / covered | success 10/10 each, no action (the click hit the window) | refused 10/10 each |
| Button of a window showing a sheet, front / covered | success, action ran 10/10 each | refused 10/10 each, no action |
| Same, background `el.click()` | refused 10/10 (key-window guard) | refused 10/10 (sheet) |
| Button removed / disabled | refused 10/10 each (stale ref / disabled) | same |

False refusals: every control `main` pressed (a native button, check box and pop-up choice, a background `el.click()`, a menu item), as "accepted by `main` / accepted by this PR" over its tries (each try in the app's own log matched between the two; a page `<select>` choice is accepted on both and rarely applied, a separate issue). No try that `main` pressed was refused: 1,290 of 1,290 accepted by both.

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

`·`: not applicable, or neither build could act (a SwiftUI picker has no `AXPress` on both, and a page `<select>` opens no menu on another Space, minimised or scrolled out of view on both; a background `el.click()` on another Space or a minimised window fails on both with `WindowNotFound`; a background click on a non-key window of the front app is refused on both by the key-window guard).

Read-only census of the rule on stock apps (front window, then covered by another app's window): Finder, Notes, Reminders, Calendar, Contacts, Preview, Font Book, Automator, Activity Monitor, System Settings, TextEdit, Safari, LibreOffice (start centre and a Calc document), GnuCash, TextEdit's Save sheet, Messages and Maps (Mac Catalyst), the fixture and Preview in full screen; Finder and Activity Monitor over every element with area, as a background `el.click()` sees them. 1,979 elements walked; judged: the Safari sidebar's tab-group chevron, a `go down` check box shown only while the pointer is over its row (front and covered), and in Finder and Activity Monitor a 14-point unlabelled group drawn under the window's full-screen button (`el.click()` on it is refused naming the button, which takes the click).

Cost: a press takes 0.5 to 2 ms longer at the median (AppKit 119.2 → 121.4 ms, SwiftUI 15.7 → 16.5, WKWebView 17.6 → 18.4, Chrome 17.7 → 18.5, Electron 13.9 → 14.4; 10 each).

`cargo test -p pi-natives --lib placement` (12 tests: hidden, zero-sized and sheet-covered elements refused naming what is there; covered centre, row, cell, column, containing window, another window, out-of-reach window, scrolled-out, web content, the drawn-in-another-window sheet case passing; which actions and delivery modes are judged).

## Risk

- Limits, each counted above: a hover-only control (Safari's tab-group chevron is the one found) is refused for `press()` and background `el.click()` where `main` ran its action without a hover; a takeover `el.click()` is not checked and is what the refusal names, and under `computer.backgroundFallback: "refuse"` no route reaches it. The 14-point group under the full-screen button is refused for a background `el.click()`. Web content and Chromium apps are not hit-tested, so a stale web control is still pressed as on `main` (it usually leaves the tree instead).
- Review first: `placement::require_shown` (the order of the passes) and `AppPlacement::hit`; the message text is new model-facing text.
- Rollback: revert; nothing persists.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
