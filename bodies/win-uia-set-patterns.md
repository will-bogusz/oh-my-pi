## What

I made `setValue` work on WPF sliders and combo boxes on Windows, where it failed with an error that reads like success: "UI Automation failed: The operation completed successfully".

WPF slider `setValue("70")` and combo box `setValue("Two")` with the app in front: set 0/80 → 79/79, each read back, one trial void because the app crashed before the call (Windows 10 22H2 and Windows 11, n=10 per cell, mode and OS).

> **Windows context.** A WPF slider offers UI Automation's `RangeValue` pattern, and a combo box that is not editable offers `Selection`, with one `SelectionItem` per entry once its list has been opened; neither offers the `Value` pattern a text box does. Asked for a pattern an element lacks, UI Automation returns success with no interface, which the `windows` crate turns into an error carrying HRESULT 0, whose system text is "The operation completed successfully".

| WPF `setValue`, app in front | `main` (v19.0.1) | this PR |
|---|---|---|
| slider, `"70"` | 0/40 (the success-text error) | **39/39** (one trial void: the app crashed before the call, refuse mode, Windows 10) |
| combo box, `"Two"` | 0/40 (the success-text error) | **40/40** |

Release v19.0.1 against an addon of this branch at `dab09aafb04`, interleaved in 2 rounds of 5, default and refuse mode, Windows 10 22H2 and Windows 11 (the rows add both). Later commits only change what the cells do not reach (a never-opened combo box's close now waits on the foreground) and one lint-only signature; the unit test below ran on them.

Reading order: `Win32Ax::set_number_or_item` and its slider and selection helpers, then `pattern_error`, in `win32/ax.rs`.

## Why

There was no failing HRESULT to report: the element did not offer `ValuePattern`, and `set_value` asked only for that.

Decisions:
- These writes run only while the control's window owns the foreground, checked before any validation and again before each pattern call, since each call would bring the window forward. Behind other windows the call is refused with nothing sent (`BackgroundUnavailable`), including a WPF control in a WinForms `ElementHost`, whose `RangeValue.SetValue` took the foreground on both Windows versions (measured).
- A slider takes a plain decimal number in its range; a combo box or list selects the exposed item named exactly the text. Each is read back, and a different reading fails naming both.
- Elements with their own window keep their routes, so Win32 trackbars and combo boxes are unchanged.

<details><summary>Slider and selection details</summary>

- A slider's text is sign, digits and an optional fraction, at most 15 significant digits, refused unwritten when not a number, outside the range, or read-only.
- A combo box whose list has never been opened exposes no items, so it is opened, the item selected, and the list closed again. The selection is read once more 150 ms after the close, because an app's `DropDownClosed` handler runs after the close returns (one that resets the selection did so in 20 of 20 trials within about 10 ms). A failure on any step closes a list this call opened and says what was done.
- Only items the list currently exposes are searched: a virtualized list's off-screen rows are not found, and the error says so.
- An action on a pattern the element does not offer (`invoke`, `toggle`, `expand`, `collapse`, `select`, `scrollintoview`, and `setValue`'s `Value`) says which pattern is missing instead of the success text.

</details>

## Testing

- `set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item` (ignored; needs a signed-in desktop) drives `Request::AxSetValue` on a real WPF window: a slider number and its out-of-range and non-number refusals, an open combo's item, a never-opened combo's item (opened, selected, closed), a miss that leaves the list closed, a combo whose `DropDownClosed` handler resets the selection, the window losing the foreground once the list is open, and a refusal with nothing sent behind another window. Passes on Windows 10 22H2 and Windows 11 at `54971a1bc53` (the head's production code but for the lint-only signature change).
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
