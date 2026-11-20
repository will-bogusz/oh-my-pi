## What

On Windows, scrolling a WPF list said ok and nothing moved, whether the app was in front or not; now a scroll in front really scrolls and says so only when the list moved, and one behind other windows goes to takeover or is refused instead of pretending.

WPF list, `scroll(x, y, { dy: 300 })`: in front, `ok` with nothing moved 40/40 → scrolled 40/40; behind other windows, `ok` with nothing moved 119/120 → refused or reported failed 120/120, never a false `ok` (Windows 10 22H2 and Windows 11, n=10 per cell, mode and OS).

> **Windows context.** WPF draws a whole window in one HWND and reads mouse input through its own input stack, which drops posted and sent `WM_MOUSEWHEEL` (0 of 30 each, below). UI Automation's `ScrollPattern` moves a WPF scroll viewer, but each call brings the window to the front; `ScrollItemPattern.ScrollIntoView` does not.

| WPF list, `scroll` | `main` (v19.0.1), default | this PR, default | `main`, refuse mode | this PR, refuse mode |
|---|---|---|---|---|
| WPF window in front | 0/10 (10 false `ok`) | **10/10** | 0/10 (10 false `ok`) | **10/10** |
| behind, user's window beside it | 0/10 (10 false `ok`) | 0/10: takeover refused by Windows 8, came forward after the refusal 2 | 0/10 (10 false `ok`) | 0/10 refused |
| behind, covered by the user's window | 0/10 (10 false `ok`) | 0/10 takeover refused by Windows | 0/10 (10 false `ok`) | 0/10 refused |
| behind, user typing | 0/10 (10 false `ok`) | 0/10 takeover refused by Windows | 0/10 (9 false `ok`, 1 harness error) | 0/10 refused |

Win10 22H2 VM, interleaved v19.0.1 / this branch, 2 rounds of 5. "Takeover refused by Windows": default mode reached the takeover, whose activation Windows refused on this VM (the harness's OMP does not run from a focused terminal), so the call failed with `InputFailed` naming that; the typing cells lost no user key. Windows 11 (25H2 VM, same protocol) gave the same rows: in front 10/10 in both modes against 0/10 (10 false `ok`); behind, 0 false `ok` in 60 trials against 60 (default mode: takeover refused by Windows, 2 unfocused trials came forward after the refusal; refuse mode: refused, one trial void because the harness's user window crashed).

Reading order: `would_be_silently_dropped` in `win32/delivery.rs`; `Win32Ax::scroll_at_point` and its `AxisScroll` helpers in `win32/ax.rs`, and its caller in `win32/input.rs`; the `scrollintoview` branch of `perform` in `win32/ax.rs`.

## Why

`delivery.rs` already refuses posted clicks, moves and text to WPF; the wheel was missing from that rule, so the posted message was reported as delivered.

Decisions:
- With the window in front, the scroll goes to the innermost UI Automation scroll container under the point (hit-tested, then up its ancestors) that can move on a requested axis, by the user's wheel setting (lines, or a page, per notch). An axis it cannot scroll is left out, as the wheel leaves it.
- One `ScrollPattern` step at a time, each waiting for the position to change before the next: WPF's scroll viewer queues one command per layout pass. Back-to-back calls lost no rows in the VM (120 of 120), and pacing costs about the same (60 steps in 206 ms), so the call reports how far the list really went: a step that does not move it ends the scroll, and not reaching the edge or the requested amount is `InputFailed` saying where it stopped.
- The foreground and the run's time left are checked before every step, since each step would bring the window back, and each read-back wait is capped by the run's deadline. Lost before the first step, the call is refused with nothing sent (`BackgroundUnavailable`, so `computer.backgroundFallback` decides); after it, it is `InputFailed` naming what moved, never a refusal a takeover would replay. A container that stops reporting a position after a step (UI Automation's `NoScroll`) or a read that fails is reported the same way, not as an edge reached.
- Behind other windows the scroll is refused like WPF's other pointer input. A native window the WPF window hosts under the point (a `WindowsFormsHost`, an `HwndHost`, an embedded browser) keeps `main`'s route, since the posted wheel reaches it; a scroll of no notches still sends nothing and succeeds. Without the foreground there is no route: every `ScrollPattern` call takes the foreground (30 of 30 per call kind, below).
- `scrollintoview` on an element whose UI Automation framework is WPF runs without the foreground guard: `ScrollIntoView` scrolled 30 of 30 with the foreground left alone. It then reads the element's `IsOffscreen` and fails when it is still off screen, as a collapsed combo box's item stays (measured).

Limits:
- A WPF window with no `ScrollPattern` container under the point gets no in-front route and is refused, so the default mode takes over.
- Not measured, so left as before: WinUI 3 and other XAML hosts.

## Testing

TESTING

<details><summary>Route probes without OMP (Windows 10 22H2 VM)</summary>

| target | route | cond | n | acted | took fg | z changed | observer fg left user | keys lost (typing) | errors |
|---|---|---|---|---|---|---|---|---|---|
| wpf-list | move-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | move-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | move-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | posted-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | posted-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | posted-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | sent-wheel-root | covered | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | sent-wheel-root | side | 10 | 0/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | sent-wheel-root | typing | 10 | 0/10 | 0/10 | 0/10 | 0/10 | 0 |  |
| wpf-list | uia-scroll | covered | 10 | 10/10 | 10/10 | 10/10 | 10/10 | - |  |
| wpf-list | uia-scroll | side | 10 | 8/10 | 8/10 | 8/10 | 8/10 | - | AttributeError: 'Control' object has no attribute 'GetScrollPattern' x2 |
| wpf-list | uia-scroll | typing | 10 | 0/10 | 10/10 | 10/10 | 10/10 | 247 |  |
| wpf-list | uia-scrollitem | covered | 10 | 10/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | uia-scrollitem | side | 10 | 10/10 | 0/10 | 0/10 | 0/10 | - |  |
| wpf-list | uia-scrollitem | typing | 10 | 10/10 | 0/10 | 0/10 | 0/10 | 0 |  |

Wheel routes are posted or sent to the list's window from outside it, or a move then wheel; `uia-scroll` is one `ScrollPattern.Scroll` (SmallIncrement), `uia-scrollitem` is `ScrollItemPattern.ScrollIntoView` of a row below the view. Typing rows: the user types into their own window during the call; `uia-scroll` brought the window forward every time and lost 247 of the user's keys over 10 trials.

</details>

- `wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored; needs a signed-in desktop) drives a real WPF list through `Request::Scroll` and `Request::AxPerform`: scrollintoview behind another window, a refused scroll behind it (no wheel message reaches the window), a posted wheel scrolling a hosted WinForms list behind it with the foreground left alone, a notch and a diagonal notch in front, a scroll to the end and one past it, and the foreground leaving after the first step. Passes on Windows 10 22H2 and Windows 11; with `win32/input.rs` and `win32/delivery.rs` taken from `main` it fails at the first scroll behind the other window, which returns `ok`.
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the final head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
