## What

I made `setValue` work on WPF sliders and combo boxes on Windows, where it failed with an error that reads like success: "UI Automation failed: The operation completed successfully".

WPF combo box `setValue("Two")` with the app in front: failed 0/40 → selected and read back 40/40 on this branch's head (Windows 10 22H2 and Windows 11, default and refuse mode, n=10 per cell).

> **Windows context.** A WPF slider offers UI Automation's `RangeValue` pattern, and a combo box that is not editable offers `Selection`, with one `SelectionItem` per entry once its list has been opened; neither offers the `Value` pattern a text box does. Asked for a pattern an element lacks, UI Automation returns success with no interface, which the `windows` crate turns into an error carrying HRESULT 0, whose system text is "The operation completed successfully".

| WPF `setValue`, app in front | v19.0.1 | this branch |
|---|---|---|
| combo box, `"Two"` (head `4d698a20393`) | 0/40, the success-text error | **40/40** |
| slider, `"70"` (earlier build `dab09aafb04`, same slider code) | 0/40, the success-text error | **39/40** read back; the 40th reported success but the app had exited before the harness read it |

Reading order: `Win32Ax::set_number_or_item` and its slider and selection helpers, then `pattern_error`, in `win32/ax.rs`.

## Why

There was no failing HRESULT to report: the element did not offer `ValuePattern`, and `set_value` asked only for that.

Decisions:
- These writes run only while the control's window owns the foreground, checked before any lookup and again before each pattern call, since each call would bring the window forward. Behind other windows the call is refused with nothing sent (`BackgroundUnavailable`), including a WPF control in a WinForms `ElementHost`: in a standalone UI Automation probe (no omp build loaded) its `RangeValue.SetValue` took the foreground on both Windows versions.
- A slider takes a plain decimal number in its range; a combo box or list selects the exposed item named exactly the text. Each is read back, and a different reading fails naming both.
- Elements with their own window keep their routes, so Win32 trackbars and combo boxes are unchanged.

<details><summary>Slider and selection details</summary>

- A slider's text is sign, digits and an optional fraction, at most 15 significant digits, refused unwritten otherwise or out of range.
- A combo box whose list has never been opened exposes no items, so it is opened, the item selected and the list closed again. The selection counts only once it still reads right 150 ms after the close, because an app's `DropDownClosed` handler runs after the close returns: in a standalone probe (no omp build loaded) a handler that resets the selection did so 20 of 20 times, 1–13 ms after the close, while an immediate read still showed the new item 16 of 20 times. A run that ends inside that window reports `AxUnconfirmed`.
- A failure closes a list this call opened and says what was done, unless the window lost the foreground, when closing it would take the foreground back.
- Only items the list currently exposes are searched: a virtualized list's off-screen rows are not found, and the error says so.
- An action on a pattern the element does not offer (`invoke`, `toggle`, `expand`, `collapse`, `select`, `scrollintoview`, and `setValue`'s `Value`) says which pattern is missing instead of the success text.

</details>

## Testing

`set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item` (ignored; needs a signed-in desktop) drives `AxSetValue` on a real WPF window: a slider number and a 16-significant-digit refusal, a never-opened combo's item (opened, selected, closed), a miss on a previously opened, now closed combo, a combo whose `DropDownClosed` handler resets the selection, the window losing the foreground once the list is open, and a refusal with nothing sent behind another window. It passed 10 of 10 runs at the head on Windows 10 22H2 and on Windows 11, and fails on both with the fix reverted. The never-opened and resetting combo boxes are covered by this test, not by the harness cells, whose combo box stays realized after its first trial.

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: pass, recorded for the head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
