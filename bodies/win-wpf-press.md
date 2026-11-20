## What

I made `press()` and a qualifying `click()` on a WPF button or check box work while its window is behind the user's, without bringing the app forward or touching the user's pointer and keys.

Behind another window, `press()` on a WPF button or check box was confirmed in 234 of 240 runs on Windows 10 and 11, where `v19.0.1` acted in none, and the user's window kept the foreground in every run.

> **Windows context.** WPF draws a window in one HWND and drops posted clicks, so omp's background route for a WPF control is UI Automation. Its `Invoke` and `Toggle` bring the window to the front, so `main` refuses them for a window that is not in front. The older LegacyIAccessible default action (`DoDefaultAction`) on the same control runs it and leaves the window where it is.

WPF fixture behind another window, `v19.0.1` → this branch, 10 runs per cell (2 interleaved rounds of 5) in each of default and refuse-takeover mode; user idle / typing / user's window over the control:

| action | Windows 10 22H2 | Windows 11 |
|---|---|---|
| `press()` button | 0 → 10, 10, 9 / 10, 10, 10 | 0 → 9, 10, 10 / 9, 10, 9 |
| `press()` check box | 0 → 10, 10, 10 / 9, 10, 10 | 0 → 10, 9, 10 / 10, 10, 10 |
| `click()` button, point visible | 0 → 10 / 10 | 0 → 10 / 10 |
| `click()` button, point under the user's window | refused → refused | refused → refused |

Reading order: `legacy_window`, `LegacyPress` (`prepare`, `run`) and their use in `Win32Ax::perform` and `invoke_at_point` in `win32/ax.rs`.

## Why

`ensure_pattern_safe` refuses UI Automation actions on a WPF window that is not in front, so `press()` was refused in either mode and a default-mode `click()` fell back to takeover.

Decisions:
- Only a WPF button or check box takes the route; a list row's default action can open the row instead of selecting it. A WPF window with a Chromium/WebView2 child window keeps `main`'s refusal.
- A check box's state is read back: unchanged is `AxUnconfirmed`, never a second send. A button's action runs after the call returns, so a provider reply that arrives after the cutoff is `AxUnconfirmed`, never success.
- The route marks the dispatch fence right before `DoDefaultAction`. A `press()` the caller stops waiting for after that mark is `AxUnconfirmed`; one abandoned before it sends nothing. A coordinate `click()` is outside the fence, like every other Windows click route, and keeps `main`'s `Timeout`.
- The default action toggles a check box as `Toggle` does: `Checked`/`Unchecked` fire, its `Click` handler does not. The docs say so.

Not covered: XAML (WinUI, UWP) controls. The route requires the framework id `WPF`, so they keep `main`'s outcome.

## Testing

`press_and_click_act_on_a_wpf_window_behind_another_and_leave_it_there` (ignored; needs a signed-in desktop) opens a WPF window behind another window of the same app: a button and a check box act and the window stays behind; a list row and disabled controls send nothing; a check box that keeps its state is `AxUnconfirmed` after one action; a click acts until the button is covered. It passes on Windows 10 and 11 and fails at the first press with the route disabled (`LegacyPress::prepare` returning `None`).

<details><summary>Refusal cases and the runs behind the numbers</summary>

A click takes the route only while the point still shows that control. A disabled control fails with `InputFailed`. A click whose check-box state cannot be read before sending keeps its takeover route (`BackgroundUnavailable`). WebView2's composition control has no child window and is not detected; web elements are excluded by framework id. Nothing is sent in any of these refusals. A blocked provider call holds the worker until it returns: the deadline is checked between calls, not during one, so a `press()` blocked in or after `DoDefaultAction` ends as `AxUnconfirmed`, and a `click()` the caller gave up on is `Timeout`.


Foreground taken: 0 on this branch in every cell (`v19.0.1`: 1 per OS, a covered click in default mode). User keys lost: 0 on both. In the 6 `press()` runs short of 10 the call returned success: 3 ended with the fixture app or the harness's user window exiting, 2 with the fixture's state unreadable after its action event, and 1 with its counter carried over from the run before (one action event).

Eligibility is decided at the send: a window that leaves the front during the lookups still takes the route, and one that gained a Chromium child is refused before anything is sent.

Builds: this branch's test binary and release addon cross-built with cargo-xwin; the addon replaced the `v19.0.1` release's natives for the "after" runs, the release itself was the "before". Rounds alternate before/after on the same guest. In the user-typing and covered conditions the user's window lies over the button, so a coordinate click there is refused on both.

</details>

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt pass on this diff.
