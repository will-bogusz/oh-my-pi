## What

I made `scroll` on a WPF window stop reporting success for a wheel the window dropped: in front, it now scrolls the list under the point and checks that it moved; where WPF has no background route, it hands the scroll to the fallback, which by default tries a real wheel.

> WPF drops posted and sent `WM_MOUSEWHEEL`, so `main`'s background wheel reported `ok` while nothing moved. UI Automation's `ScrollPattern` scrolls it, but brings a window behind others to the front.

| WPF, one notch, Win 10 / Win 11 | v19.0.1 | this branch |
|---|---|---|
| list in front, per mode (n=10) | false `ok` 10/10 / 10/10 | scrolled 10/10 / 10/10 |
| list behind, refuse (n=20) | false `ok` 20/20 / 20/20 | `BackgroundUnavailable` 20/20 / 20/20, nothing sent |
| list behind, default (n=20) | false `ok` 20/20 / 20/20 | takeover scrolled 0/20 / 10/20, rest `InputFailed`; no false `ok` |
| no container, refuse (n=30) | false `ok` 30/30 / 30/30 | `BackgroundUnavailable` 30/30 / 30/30 |

## Why

`delivery.rs` refused posted clicks and text to WPF but not the wheel.

- In front, over a UI Automation scroll container: `ScrollPattern`, one step per wheel-setting increment; each axis hit-tests the point again (`scroll_at_point`).
- A step counts once the container's child under the point moves the requested way (80/80 one-notch steps per OS; still on 80/80 resize-only changes, where the percent moved on 70). Still after 500 ms: `InputFailed`; no child, wrong way, or the cutoff after a send: `AxUnconfirmed`.
- Any other WPF scroll (behind, no container, a Chromium/WebView2 child, WPF in a non-WPF window, wheel set to 0 on every axis) is `BackgroundUnavailable` with nothing sent, so `computer.takeover` decides; a hosted non-WPF child keeps posting.
- On this route, past the posted wheel's range (273 notches per axis): `InputFailed`; non-finite anywhere.

Limits: if the first axis moved and the second finds no container under the point: `AxUnconfirmed`, first axis applied, no takeover rerun. With no container, default mode's takeover wheel can be `ok` without a read-back. A scroll whose last step to an edge is under one pixel can report that the offset did not move although the view reached the edge. A window moved mid-step can confirm a step that scrolled nothing; a fixed control in the viewer reports `InputFailed`; a blocked provider can hold one call past the cutoff.

## Testing

`wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved` (ignored) drives each route live. `wpf_mixed_scroll_scrolls_the_list_the_horizontal_axis_brings_under_the_point` (ignored) puts two lists side by side in a horizontal viewer; the vertical step must scroll the one the horizontal step brought under the point.

Cells: v19.0.1 vs an addon from `4dd113f40f8`, 2×5 per mode; in-front trials moved neither focus nor pointer. GitHub-hosted windows-latest runner, at `3fa23fb0d87` plus the two-list test and CI-only diagnostics (this head differs in test code only): desktop units pass (242); the two-list test 3/3; with the re-hit reverted it fails, the vertical step going to the first list and the horizontal assertion failing first (why that build skipped the horizontal axis is not established); the route test passes up to a page-swap step this head drops.

Not covered live: a first axis that moves, then no container for the second.

`scripts/rust-check` passes on Linux and macOS; Windows `cargo xwin clippy -p omp-natives` adds no warning (full check blocked on `main`).
