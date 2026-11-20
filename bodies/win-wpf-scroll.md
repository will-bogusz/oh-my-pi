## What

I made `scroll` on a WPF window stop reporting success for a wheel the window dropped: in front, it now scrolls the list under the point and checks that it moved; anywhere else it refuses and says what works.

> **Windows context.** WPF draws a window in one HWND and drops posted and sent `WM_MOUSEWHEEL` (0 of 30 each in the route probe below), so `main`'s background wheel reported `ok` while nothing moved. UI Automation's `ScrollPattern` moves a WPF scroll viewer but brings a window behind others to the front.

| WPF window, `scroll` one notch | v19.0.1 | this branch |
|---|---|---|
| list in front, Windows 10 22H2 / 11 | false `ok` 5/5 / 5/5 | scrolled **5/5** / **5/5** |
| list behind (beside, covered, user typing), Windows 10 22H2 / 11 | false `ok` 15/15 / 15/15 | `Unsupported` **15/15** / **15/15**, nothing sent |
| in front, no scroll container under the point, Windows 10 22H2 / 11 | false `ok` 10/10 / 10/10 | `Unsupported` **10/10** / **10/10**, nothing sent |

Reading order: `refusal`, `wpf_scroll_unsupported` and `pointer` in `win32/input.rs`; `Win32Ax::scroll_at_point` and `ScrollRun` in `win32/ax.rs`.

## Why

`delivery.rs` refused posted clicks and text to WPF but not the wheel.

Decisions:
- A posted wheel to a WPF window is never reported `ok`.
- In front, over a UI Automation scroll container, the scroll goes through `ScrollPattern`, one step per wheel-setting increment, each axis on its own. A step counts only when that axis's scroll percent moved the requested way with its view size unchanged; a view-size change is `AxUnconfirmed`, no movement `InputFailed`.
- Scroll's own cutoff, the operation deadline less the reply's margin, is checked around every UI Automation call; past it, `AxUnconfirmed` if a step was sent, else a failure with nothing sent. The caller's timeout comes later, so a call ending in between still gets this error.
- Every other WPF case (behind other windows, no scroll container, an unmapped point, a provider failure before any step) is `Unsupported` with nothing sent, naming what works: the front, or `takeover: true`. It is not `BackgroundUnavailable`, so default mode never takes over on its own.
- A hosted WinForms list under the point keeps `main`'s posted wheel; other hosted children do not, and a WPF window hosting Chromium keeps `main`'s refusal.

Limits: WPF exposes scroll percent and view size, not offsets: a resize that keeps the view size and moves the percent the requested way counts as a scroll. A blocked provider can hold one call past both (client timeouts did not cut it short on Windows 10 or 11); the caller then gets `main`'s `Timeout`. XAML hosts: not measured.

## Testing

`wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored: needs a desktop) drives `Request::Scroll` on a WPF list beside a hosted WinForms list: behind another window, `Unsupported`, nothing sent; the WinForms list takes the posted wheel; a synthetic Chromium descendant keeps the refusal; in front, one notch moves by the wheel setting, at the end `InputFailed`, a list growing during the step `AxUnconfirmed`, no container `Unsupported`, explicit takeover sends the real wheel. It passes on Windows 10 and 11 and fails on both with the view-size check removed; non-ignored tests pass too. Units and cells ran on `4a25afbb728`, before the import-only rebase.

<details><summary>Builds and runs behind the numbers</summary>

- Release v19.0.1 (`f40f335845f`) against an addon built from `4a25afbb728`, through the harness's `scroll` (`dy: 3`), 1 round per build, v19.0.1 cells then branch cells: `PM-scroll-list` n=5 per condition, and `PM-scroll-canvas` (the fixture's Canvas border, which has no scroll container) n=10 in front. Windows 11 and Windows 10 12:51-13:00Z. Every reply in the table is counted; the harness also flagged one v19.0.1 Windows 11 covered trial (its observer window closed) and one branch Windows 10 typing trial (the fixture app was closed after the `Unsupported` reply). No trial lost a user key.
- Explicit `takeover: true` is not a harness cell: Windows refused the harness's activation on both v19.0.1 and an earlier build of this branch (5 of 5 each), so the unit test's explicit-takeover step carries that case.

</details>

<details><summary>Route probes without omp (Windows 10 22H2)</summary>

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
| wpf-list | uia-scroll | side | 10 | 8/10 | 8/10 | 8/10 | 8/10 | - | probe error x2 |
| wpf-list | uia-scroll | typing | 10 | 0/10 | 10/10 | 10/10 | 10/10 | 247 |  |


Wheel routes are posted or sent to the list's window from outside it, or a move then wheel; `uia-scroll` is one `ScrollPattern.Scroll` (SmallIncrement). Typing rows: the user types into their own window during the call; `uia-scroll` brought the window forward every time and lost 247 of the user's keys over 10 trials. One series of 10 per cell, through the probe script, not omp.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the head.

