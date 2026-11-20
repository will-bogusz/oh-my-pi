## What

I made `press()` and a qualifying `click()` on a WPF button or check box work while its window is behind the user's, without bringing the app forward or touching the user's pointer and keys.

Behind another window, `press()` on a WPF button or check box was confirmed in 240 of 240 runs on Windows 10 and 11, where `v19.0.1` acted in none, with no measured foreground takeover.

> **Windows context.** WPF draws a window in one HWND and drops posted clicks, so omp's background route for a WPF control is UI Automation. Its `Invoke` and `Toggle` bring the window to the front, so `main` refuses them for a window that is not in front. The older LegacyIAccessible default action (`DoDefaultAction`) on the same control runs it and leaves the window where it is.

WPF fixture behind another window, `v19.0.1` → this branch, 10 runs per cell in each of default and refuse-takeover mode; user idle / typing / their window over the control:

| action | Windows 10 22H2 | Windows 11 |
|---|---|---|
| `press()` button | 0 → 10, 10, 10 / 10, 10, 10 | 0 → 10, 10, 10 / 10, 10, 10 |
| `press()` check box | 0 → 10, 10, 10 / 10, 10, 10 | 0 → 10, 10, 10 / 10, 10, 10 |
| `click()` button, point visible | 0 → 10 / 10 | 0 → 10 / 10 |
| `click()` button, point under the user's window | 0 → 0 confirmed | 0 → 0 confirmed |

Reading order: `legacy_window`, `LegacyPress` (`prepare`, `run`) and their use in `Win32Ax::perform` and `invoke_at_point` in `win32/ax.rs`.

## Why

`ensure_pattern_safe` refuses UI Automation actions on a WPF window that is not in front, so `press()` was refused in either mode and a default-mode `click()` fell back to takeover.

Decisions:
- Only a WPF button or check box takes the route; a list row's default action can open the row instead of selecting it. A WPF window with a Chromium/WebView2 child window keeps `main`'s refusal.
- A check box's state is read back: unchanged is `AxUnconfirmed`, never a second send. A button's reply after the cutoff is `AxUnconfirmed`, never success.
- The route marks the dispatch fence right before `DoDefaultAction`: a `press()` the caller abandons after that is `AxUnconfirmed`, before it nothing is sent. A coordinate `click()` is outside the fence like every Windows click route; its `Timeout` does not prove nothing was pressed.
- The default action toggles a check box as `Toggle` does: `Checked`/`Unchecked` fire, its `Click` handler does not (documented).

Not covered: XAML (WinUI, UWP) keeps `main`'s outcome.

## Testing

`press_and_click_act_on_a_wpf_window_behind_another_and_leave_it_there` (ignored; needs a signed-in desktop) opens a WPF window behind another window of the same app: a button and a check box act and the window stays behind; a list row and disabled controls send nothing; a check box that keeps its state is `AxUnconfirmed` after one action; a click acts until the button is covered. It passes on Windows 10 and 11 and fails at the first press with the route disabled (`LegacyPress::prepare` returning `None`).

`a_wpf_press_route_past_its_cutoff_ends_in_timeout_not_a_refusal_or_a_miss` (injected cutoff): past the route's cutoff a late miss or refusal is `Timeout`, never a takeover. It passes on Windows 10 and 11 and fails with the previous order.

<details><summary>Refusal cases and the runs behind the numbers</summary>

A click takes the route only while the point still shows that control. A disabled control fails with `InputFailed`. A click whose check-box state cannot be read before sending (a failure other than a timeout, before the route's cutoff) keeps its takeover route (`BackgroundUnavailable`). WebView2's composition control has no child window and is not detected; web elements are excluded by framework id. Nothing is sent in any of these refusals. A blocked provider call holds the worker until it returns: the deadline is checked between calls, not during one. A `press()` whose provider call outlasts the caller's wait after the dispatch mark ends as `AxUnconfirmed`; a provider failure returned in time is `AxFailed`; a `click()` the caller gave up on is `Timeout`.

The route has its own cutoff, separate from the caller's deadline: at most 500 ms for a check box, the caller's remaining time for a button (500 ms when it has none). Once it passes nothing more is sent, and a refusal or a point that no longer shows the control is `Timeout` with nothing sent, so a late check cannot hand a click to takeover.


Foreground taken: 0 on both sides in every cell of these runs; an earlier round of the same cells (before this revision's cutoff change) recorded 1 per OS for `v19.0.1`, a covered click in default mode, and 0 for this branch. User keys lost and pointer moved: 0 on both.

For a click, the background attempt is decided at the point route's last ordinary check: a window that leaves the front during the lookups takes the default-action route there, and a window that gained a Chromium child is refused before anything is sent. A `press()` that passed its ordinary check before the window left the front keeps `main`'s behaviour. A background attempt whose point is covered is refused; in default mode that click can still go to takeover.

Builds: this branch's test binary and release addon cross-built with cargo-xwin; the addon replaced the `v19.0.1` release's natives for the "after" runs (natives sha256 `D1C80A74…`), the release itself was the "before" (`20098A21…`). Rounds alternate before/after on the same guest. In the user-typing and covered conditions the user's window lies over the button, so no coordinate click there was confirmed on either side.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS passes on this diff.
