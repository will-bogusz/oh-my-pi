## What

I made `scroll` on a WPF window stop reporting success for a wheel the window dropped: in front, it now scrolls the list under the point and checks that it moved; anywhere else it hands the scroll to the background fallback, which by default reruns it with a real wheel.

> **Windows context.** WPF draws a window in one HWND and drops posted and sent `WM_MOUSEWHEEL` (0 of 30 each in the route probe below), so `main`'s background wheel reported `ok` while nothing moved. UI Automation's `ScrollPattern` moves a WPF scroll viewer but brings a window behind others to the front.

| WPF window, `scroll` one notch, n=10 per cell | v19.0.1 | this branch |
|---|---|---|
| list in front | false `ok` 10/10 / 10/10 | scrolled **10/10** / **10/10** |
| list behind (beside or covered), refuse mode | false `ok` 20/20 / 20/20 | `BackgroundUnavailable` **20/20** / **20/20**, nothing sent |
| list behind, default mode | false `ok` 20/20 / 20/20 | takeover scrolled **0/20** / **10/20**; Windows refused the takeover's activation in the rest (`InputFailed`, nothing scrolled); no false `ok` |
| point with no scroll container, refuse mode | false `ok` 30/30 / 30/30 | `BackgroundUnavailable` **30/30** / **30/30**, nothing sent |
| point with no scroll container, default mode | false `ok` 30/30 / 30/30 | takeover wheel ran, nothing to scroll: `ok` 30/30 / 30/30 (see Limits) |

Windows 10 22H2 / Windows 11.

Reading order: `pointer` in `win32/input.rs`; `scroll_at_point`, `Sample::moved_to`, `ScrollRun` in `win32/ax.rs`.

## Why

`delivery.rs` refused posted clicks and text to WPF but not the wheel.

Decisions:
- A posted wheel to a WPF window is never reported `ok`.
- In front, over a UI Automation scroll container, the scroll goes through `ScrollPattern`, one step per wheel-setting increment, each axis on its own. A step counts when the offset moved the requested way; rows added or removed during the step do not count. No movement is `InputFailed`.
- A cutoff before the reply deadline is checked around every UI Automation call: past it, `AxUnconfirmed` if a step was sent.
- Every other WPF scroll (behind other windows, no container under the point, a Chromium/WebView2 child window, WPF hosted in a non-WPF window, wheel scrolling set to 0, a provider failure before any step) is `BackgroundUnavailable` with nothing sent, as `main` answers other WPF pointer input, so `computer.backgroundFallback` decides.
- A non-WPF child window under the point (a hosted WinForms list) keeps `main`'s posted wheel.

Limits: a blocked provider can hold one call past the cutoff (`main`'s `Timeout`). A default-mode takeover wheel over a point where nothing scrolls reports `ok`, as `main`'s takeover scroll does in any window. XAML hosts: not measured.

## Testing

`wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored: needs a desktop) drives `Request::Scroll` on a WPF list beside a hosted WinForms list: behind, `BackgroundUnavailable` with nothing sent; the WinForms list takes the posted wheel; in front, one notch moves by the wheel setting, at the end or with rows added `InputFailed`, no container `BackgroundUnavailable`. It passes on Windows 10 and 11 and fails on both with this round's `ax.rs` and `input.rs` reverted; the `win32::ax` unit tests pass.

**Rows of different heights.** A `ListBox` scrolls by item, so the rows in view, and its view size, change as it scrolls. Ten one-notch scrolls per OS on mixed-height rows: the previous head reported `AxUnconfirmed` **10/10** on Windows 10 and **10/10** on 11; this head confirms **10/10** and **10/10**. With wheel scrolling set to 0, a takeover wheel still scrolled 3/3 per OS.

<details><summary>Builds and runs behind the numbers</summary>

- Cells: release v19.0.1 against an addon built from `6c5747aa540`, harness `scroll` (`dy: 3`), 2 rounds of 5 per cell, conditions in front, beside (unfocused) and covered, modes default (`omp`) and refuse (`omp-refuse`); `PM-scroll-canvas` is the fixture's Canvas border, which has no scroll container. Windows 11 17:05-17:24Z, Windows 10 17:12-17:33Z. No trial lost a user key.
- `verified build: ref v19.0.1 sha f40f335845f… natives pi_natives.win32-x64-baseline.node sha256 20098A21…81661` (v19.0.1 side, both OS); branch side: same ref with the addon, `sha256 808D0A87…62B345` (both OS).
- Variable-height runs: an ignored measurement test on a scratch branch (this head plus the test, and the previous head plus the test), not part of the PR.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded at `6c5747aa540`.
