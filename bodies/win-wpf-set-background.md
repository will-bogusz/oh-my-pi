## What

I made `setValue` work on a WPF text box, slider or combo box whose window is behind the user's, without bringing the app forward.

Behind another window, `setValue` on a WPF text box, three sliders and an opened combo box wrote and read back the value in 300 of 300 runs on Windows 10 and 11 (`v19.0.1`: 0 of 150); the window never came forward.

> **Windows context.** UI Automation writes can bring a WPF window to the front, so omp refuses them behind another window (`main` for `Value`; the queued `win-uia-set-patterns` adds `RangeValue` and `SelectionItem` in front only). The older LegacyIAccessible pattern writes without activating the window; on a slider its value is a whole percent of the range (probe below).

WPF fixture behind another window, `v19.0.1` (5 runs) → this branch (10 runs) per cell; user idle / typing / their window over the control:

| `setValue` | Windows 10 22H2 | Windows 11 |
|---|---|---|
| text box | 0 → 10, 10, 10 | 0 → 10, 10, 10 |
| slider 0 to 100 snapping to 5, `35` | 0 → 10, 10, 10 | 0 → 10, 10, 10 |
| slider -2 to 8, `2.7` | 0 → 10, 10, 10 | 0 → 10, 10, 10 |
| slider 0.5 to 1.5, `0.83` | 0 → 10, 10, 10 | 0 → 10, 10, 10 |
| combo box opened earlier | 0 → 10, 10, 10 | 0 → 10, 10, 10 |
| combo box never opened | refused → refused | refused → refused |

Reading order: `Win32Ax::set_background_value`, `set_background_text`, `set_number` and `select_item` in `win32/ax.rs`; `dispatch_fenced` in `desktop/mod.rs`.

## Why

Behind another window a WPF `setValue` was refused, so filling in a form meant taking the user's screen.

Decisions:
- Only a WPF control in a WPF window with no Chromium/WebView2 child window takes the route, and only while the window is behind; in front, the ordinary write runs.
- A background legacy write succeeds only on a matching read-back: the text, the slider's number, or exactly the requested item selected. A readable mismatch is `AxFailed` for text and `InputFailed` for a number or item, naming what the control holds; an unreadable read-back after a send is `AxUnconfirmed`.
- On the background legacy route, password boxes and read-only text boxes are refused before anything is sent.
- Every Windows `setValue` send marks the dispatch fence of `desktop-dispatch-fence` right before it (details below).

Limits: while behind, an otherwise valid slider value must land exactly on a whole percent of its range (for example, steps of 10 on 0 to 1000). Other in-range values are refused before sending, with the nearest admissible alternatives if there are any; in front, the ordinary numeric write has no whole-percent restriction. A combo box behind other windows can select only items it already exposes: one whose list has never been opened exposes none and is refused.

Related: #19814 (classic Win32 edit values without activation).

## Testing

`set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item` (ignored; needs a signed-in desktop) writes a WPF window's controls behind another window: text, slider and an opened combo land; 2.75 on -2 to 8 is refused unsent naming 2.7 and 2.8, and 2.7 lands; a never-opened combo, password and read-only boxes send nothing; the window never activates. It passes on Windows 10 and 11 and fails with the route disabled (`set_background_value` returning `None`).

<details><summary>Builds and runs behind the numbers</summary>

The fence covers the in-front `Value`, `RangeValue` and `SelectionItem` writes of `win-uia-set-patterns` and the classic edit and combo messages too: a reply that misses the native reply wait after the mark is `AxUnconfirmed`, and a request whose native reply wait expired before the mark sends nothing. Ordinary foreground UIA and classic native edit/combo writes keep their existing acknowledgement and read-back rules, including password and unavailable-text-read exceptions. Pure tests cover slider admission and its neighbours, the background cutoff and the native transport fence.

Runs: the harness's WPF value fixture (a text box, the three sliders, a combo box whose list opened once at start and one replaced by a never-opened combo before each run), placed behind another window. Before = the `v19.0.1` release, after = the same release with this branch's natives (cross-built with cargo-xwin; natives sha256 `2914F90A…`, release `20098A21…`). On Windows 10 the harness scored 8 after runs (4 snap, 2 `2.7`, 1 `0.83`, 1 never-opened combo) and 3 before runs as disturbing the user: in each, the value was written as asked or refused as expected, and the foreground went to another process's window (harness consoles, another test's window, a browser prompt). The target window took the foreground in none of the after runs on either OS. User keys lost and pointer moved: 0 on both.

</details>

<details><summary>Slider probe without omp (Windows 10 22H2 and Windows 11)</summary>

LegacyIAccessible `SetValue(text)` on a WPF slider behind another window, then `RangeValue` read back; one trial per value.

| slider range | legacy text sent | slider reads |
|---|---|---|
| 0 to 100 | `3`, `37` | 3, 37 |
| -2 to 8 | `3`, `50` | -1.7, 3 |
| 0 to 1000 | `3`, `50` | 30, 500 |
| 0 to 100, snapping to ticks of 7 | `3`, `10` | 3, 10 (no snapping) |
| 0.5 to 1.5 | `1`, `33` | 0.51, 0.8300000000000001 |
| 0 to 100, -2 to 8, 0 to 1000 | `2.5` | `E_INVALIDARG`, unchanged |
| -2 to 8 | `-1` | `E_INVALIDARG`, unchanged |
| 0 to 1000 | `500` | `E_INVALIDARG`, unchanged |

The cover window was in the foreground before and after every trial.

</details>

`scripts/rust-check` on Windows (cargo-xwin) and Linux passes on this diff; macOS not run on it (no macOS build host).
