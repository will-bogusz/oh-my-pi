## What

I made `scroll` on a WPF window stop reporting success for a wheel the window dropped: in front, it now scrolls the list under the point and checks that it moved; anywhere else it hands the scroll to the background fallback, which by default reruns it with a real wheel.

> **Windows context.** WPF draws a window in one HWND and drops posted and sent `WM_MOUSEWHEEL` (0 of 30 each in the route probe below), so `main`'s background wheel reported `ok` while nothing moved. UI Automation's `ScrollPattern` moves a WPF scroll viewer but brings a window behind others to the front.

| WPF window, `scroll` one notch, n=10 per cell | v19.0.1 | this branch |
|---|---|---|
| list in front | false `ok` 10/10 / 10/10 per mode | scrolled **10/10** / **10/10** per mode (default and refuse) |
| list in front, rows of mixed heights | false `ok` 10/10 / 10/10 (PR base, same posted wheel) | scrolled and confirmed **10/10** / **10/10** |
| list behind (beside or covered), refuse mode | false `ok` 20/20 / 20/20 | `BackgroundUnavailable` **20/20** / **20/20**, nothing sent |
| list behind, default mode | false `ok` 20/20 / 20/20 | takeover scrolled **0/20** / **10/20**; Windows refused the takeover's activation in the rest (`InputFailed`, nothing scrolled); no false `ok` |
| point with no scroll container, refuse mode | false `ok` 30/30 / 30/30 | `BackgroundUnavailable` **30/30** / **30/30**, nothing sent |
| point with no scroll container, default mode | false `ok` 30/30 / 30/30 | takeover wheel ran, nothing to scroll: `ok` 30/30 / 30/30 (see Limits) |

Windows 10 22H2 / Windows 11.

Reading order: `pointer` in `win32/input.rs`; `scroll_at_point`, `content_child`, `ScrollRun::step` in `win32/ax.rs`.

## Why

`delivery.rs` refused posted clicks and text to WPF but not the wheel.

Decisions:
- A posted wheel to a WPF window is never reported `ok`.
- In front, over a UI Automation scroll container, the scroll goes through `ScrollPattern`, one step per wheel-setting increment, each axis on its own.
- A step counts once the container's child under the point moves on screen the requested way. Unmoved for 500 ms is `InputFailed`; no such child, a move the other way, or the cutoff before the reply deadline is `AxUnconfirmed`.
- Every other WPF scroll (behind, no container under the point, a Chromium/WebView2 child window, WPF hosted in a non-WPF window, wheel scrolling set to 0, a provider failure before any step) is `BackgroundUnavailable` with nothing sent, so `computer.backgroundFallback` decides.
- A non-WPF child window under the point (a hosted WinForms list) keeps `main`'s posted wheel.

Why content: `ScrollPattern`'s percent also moved on 70/80 resize-only changes per OS, and a `ListBox` exposes no scroll bar to UI Automation; the child under the point moved on 80/80 one-notch steps per OS (equal rows, mixed heights, a growing pixel-scrolled list, a plain `ScrollViewer`) and held on 80/80 resize-only changes.

Limits: a blocked provider can hold one call past the cutoff (`main`'s `Timeout`). With no scroll container, default mode delivers a real wheel and reports it delivered; whether the content moved is not read back, as for any takeover scroll. Screen positions are compared: a window moved mid-step reads as a step, a viewer child that does not scroll as no movement, and a failed child read at a range end refuses. XAML hosts: not measured.

## Testing

`wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored) covers the routes beside a hosted WinForms list; it passes on Windows 10 and 11. `wpf_scroll_deadline_and_offset_readback` feeds `ScrollRun::step` the review's cases (five short rows replacing a tall one, rows removed as the view shrinks, a torn reading); it passes on both OS, and the previous read-back gets 5 of its 9 wrong. Rust and worker tests pin the unsent suffix.

<details><summary>Builds and runs behind the numbers</summary>

- Cells: release v19.0.1 against an addon built from `4dd113f40f8` (plus test-only scratch commits), harness `scroll` on `PM-scroll-list` in front, default (`omp`) and refuse (`omp-refuse`), 2 rounds of 5. Windows 10 19:23-19:33Z, Windows 11 19:29-19:37Z. No trial took the foreground, lost a user key or moved the pointer. Behind/no-container rows: unchanged from the previous head's runs (this round does not touch routing).
- `verified build: ref v19.0.1 sha f40f335845f… natives pi_natives.win32-x64-baseline.node sha256 20098A21…81661` (v19.0.1 side, both OS); branch side: same ref with the addon, `sha256 D2BF1161…EB66D` (both OS).
- Mixed heights and the content measurements: ignored test-only measurements on a scratch branch (this head, and the PR base for the mixed-height row), not part of the PR.

</details>

`scripts/rust-check` on Windows (cargo-xwin) and Linux: pass, recorded at `fe0a416586`; macOS: pending a host.
