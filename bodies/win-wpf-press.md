## What

I made `press()` on a WPF button or check box work while its window is behind the user's, without bringing the app forward or touching the user's pointer and keys.

Behind another window, `press()` on the fixture's WPF button and check box was confirmed in 119 of 120 runs on Windows 10 and 11, where `v19.0.1` refused all of them; the WPF window never came forward.

`v19.0.1` → this branch, 5 runs per cell; default / refuse-takeover mode, each with the user idle, typing, and with their window over the control:

| `press()` on | Windows 10 22H2 | Windows 11 |
|---|---|---|
| button | 0 → 5, 5, 5 / 5, 4, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| check box | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |

Reading order in `win32/ax.rs`: `legacy_window`, `LegacyPress`, `Win32Ax::contained_or`, `Win32Ax::perform`.

## Why

`ensure_pattern_safe` refuses UI Automation actions on a WPF window that is not in front, because WPF's `Invoke` and `Toggle` bring that window forward. The control's LegacyIAccessible default action (`DoDefaultAction`) runs the same action without activating the window.

Decisions:
- Only containment's refusal of a `press()` tries this route; anything that does not qualify gets that same refusal.
- Only a WPF button with `Invoke` or check box with `Toggle` that has a default action qualifies (a list row's can open the row). Right before sending, the window must still have no Chromium/WebView2 child window (else the refusal stands) and not be disabled by a modal dialog (`InputFailed`).
- Before dispatch the only time bound is the call's deadline, through the dispatch fence.
- WPF applies the action later, so a check box's new state counts only if a read sees it within 500 ms (or the call's remaining time). No read starts after that, but a read already in flight is not interrupted. Not seeing the change is `AxUnconfirmed`, never a second send; a failed read is `InputFailed`.
- A check box's `Checked`/`Unchecked` fire, its `Click` handler does not (documented).

Related: #16573 changes the same refusal for WinForms. Limits: `click()` on a WPF control keeps `main`'s outcome (a follow-up covers it); WebView2 composition content without a child window is not detected; XAML (WinUI, UWP) is unchanged.

## Testing

`press_acts_on_a_wpf_window_behind_another_and_leaves_it_there` (ignored; needs a signed-in desktop) opens a WPF window behind another window of the same app. A button and a check box act and the window stays behind; a list row and disabled controls send nothing; a check box that keeps its state is `AxUnconfirmed`; behind the window's modal dialog both send nothing (`InputFailed`). Run at `5bcfae24682` (this head plus a fixture read timeout), it passes on Windows 10 and 11 and fails on both with the route off (first button press) and with the modal check removed (dialog row).

Not tested (races the fixture has no seam for): the read-back window's edges, a Chromium child attached during the provider reads, and the foreground changing during containment's one sample.

<details><summary>The runs behind the numbers</summary>

Runs: the harness's WPF press fixture (FX-WPF) behind another window, 5 runs per cell. Before = the `v19.0.1` release (natives sha256 `20098A21…`), after = the same release with this branch's natives, cross-built with cargo-xwin at `2cb81daa27a`, whose production code is this head's (sha256 `F946EA81…`). The one run not counted (Windows 10, refuse-takeover, user typing) pressed the button, but Windows' Copilot window took the foreground during it. User keys lost and pointer moved: 0 in every typing cell.

</details>

`scripts/rust-check` on Windows (cargo-xwin) and Linux: clippy and rustfmt pass on this branch's lines at `73b8e40f8d2`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
