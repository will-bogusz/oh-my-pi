## What

I made `setValue` work on a WPF text box, slider or combo box whose window is behind the user's, without bringing the app forward.

Behind another window, `setValue` on the fixture's WPF text box, three sliders and an opened combo box was written and read back in 300 of 300 runs on Windows 10 and 11, where `v19.0.1` refused all of them; the WPF window never came forward.

`v19.0.1` → this branch, 5 runs per cell; default / refuse-takeover mode, each with the user idle, typing, and with their window over the control:

| `setValue` | Windows 10 22H2 | Windows 11 |
|---|---|---|
| text box | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| slider 0 to 100 snapping to 5, `35` | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| slider -2 to 8, `2.7` | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| slider 0.5 to 1.5, `0.83` | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| combo box opened earlier | 0 → 5, 5, 5 / 5, 5, 5 | 0 → 5, 5, 5 / 5, 5, 5 |
| combo box never opened | refused → refused | refused → refused |

`main` refuses these too: WPF text boxes have no native `Edit` window for #19814's route, and containment's WPF refusal is unchanged.

Reading order in `win32/ax.rs`: `Win32Ax::set_value`, `set_behind`, `legacy_dispatch`, `legacy_readback`; then `dispatch_fenced` in `desktop/mod.rs`.

## Why

`ensure_pattern_safe` refuses UI Automation writes on a WPF window that is not in front, because WPF's `Value`, `RangeValue` and `SelectionItem` bring it forward. The control's LegacyIAccessible value, or its item's LegacyIAccessible selection, writes without activating the window; on a slider that value is a whole percent of the range (probe below).

Decisions:
- Only containment's refusal of a WPF window tries this route; anything that does not qualify keeps that refusal, and in front nothing changes.
- Right before sending, the window must still have no Chromium/WebView2 child window and must not be disabled by a modal dialog (`InputFailed`). Password and read-only text boxes are refused unsent.
- Before dispatch this route's only time bound is the call's deadline, via the dispatch fence, which now marks every Windows `setValue` send.
- A background write counts only if a read sees it within 500 ms (or the call's remaining time). No read starts after that, but a read already in flight is not interrupted. Not seeing it is `AxUnconfirmed`; a failed read is `InputFailed`.

Limits: behind other windows a slider takes only a number at a whole percent of its range (steps of 10 on 0 to 1000); another valid number is refused unsent, naming the nearest that are, if any. In front that restriction does not apply. A combo box selects only items it already exposes, so one never opened is refused.

Related: #19814.

## Testing

`set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item` (ignored; needs a signed-in desktop) now also writes behind another window: text, slider and an opened combo land; 2.75 on -2 to 8 is refused naming 2.7 and 2.8; a never-opened combo, password and read-only boxes, and all three controls behind the window's modal dialog (`InputFailed`) are refused and change nothing. At `e02e94349fd` (before the rebase onto `main`) it passes on Windows 10 and 11 and fails on both with the route turned off.

<details><summary>The runs behind the numbers</summary>

Runs: the harness's WPF value fixture (FX-WPF-VALUES: a text box, the three sliders, a combo box whose list opened once at start, and one replaced by a never-opened combo before each run) behind another window, 5 runs per cell. Before = the `v19.0.1` release (natives sha256 `20098A21…`), after = the same release with this branch's natives, cross-built with cargo-xwin from `e02e94349fd` (sha256 `47206CDE…`). User keys lost and pointer moved: 0 in every typing cell. In one Windows 10 `v19.0.1` run (refused, as all were) another window took the foreground; none did in any run of this branch. Pure tests (slider admission and neighbours, native message fence, dispatch fence) pass on both.

In a tree merging this head with the other open natives PRs, the live test also passes on a GitHub-hosted windows-latest runner (Windows Server 2025 24H2, build 26100.33828, interactive session).

`e02e94349fd` is this change before its rebase onto `main`, which changed none of its Rust lines. Not tested (races the fixture has no seam for, and the poll has no clock seam): the read-back window's edges and a Chromium child attached during the provider reads.

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

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt pass on this branch's lines at `5ccab6c3633`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
