## What

I made `setValue` work on WPF sliders and combo boxes on Windows, where it failed with an error that reads like success: "UI Automation failed: The operation completed successfully".

With the app in front, at `6f545b59b90` (before the rebase onto `main`), slider writes went from 0/40 to 40/40 and combo box writes from 0/40 to 38/40 on Windows 10 and 11; the other two are one test app crash and one unread state, both on Windows 11.

> **Windows context.** A WPF slider offers UI Automation's `RangeValue` pattern, and a combo box that is not editable offers `Selection`, with one `SelectionItem` per entry once its list has been opened; neither offers the `Value` pattern a text box does. Asked for a pattern an element lacks, UI Automation returns success with no interface, which the `windows` crate turns into an error carrying HRESULT 0, whose system text is "The operation completed successfully".

| WPF `setValue`, app in front | v19.0.1 | this branch |
|---|---|---|
| slider (`RangeValue`), Windows 10 | 0/20, refused | 20/20 |
| slider, Windows 11 | 0/20, refused | 20/20 |
| combo box (`Selection`), Windows 10 | 0/20: 19 refused, 1 app crash | 20/20 |
| combo box, Windows 11 | 0/20: 19 refused, 1 app crash | 18/20: 1 app crash, 1 state unread |

Reading order: `Win32Ax::set_number_or_item` and its slider and selection helpers, then `pattern_error`, in `win32/ax.rs`.

## Why

No call failed: the element lacked `ValuePattern`, the only pattern `set_value` asked for.

Decisions:
- These writes run only while the control's window owns the foreground, checked before each mutating pattern call of this route, since each call would bring the window forward. Behind other windows the call is refused with nothing sent (`BackgroundUnavailable`), including a WPF control in a WinForms `ElementHost` (see details). A control offering neither `RangeValue` nor `Selection` keeps `main`'s outcome.
- A slider takes a plain decimal number in its range; a combo box or list selects the exposed item named exactly the text. Each is read back: a different reading is `AxFailed`, an unreadable one after the write `AxUnconfirmed`. In a multiple-selection list, a write that would replace other selected items is refused with nothing changed (as `main` refused it); select the item with a press or click instead.
- Win32 trackbars and combo boxes, which have their own windows, keep their routes.
- `docs/tools/computer.md` states the accepted inputs, the in-front requirement and what `AxUnconfirmed` means here; the model prompt is left to one sampled change covering scroll, the dispatch fence and `setValue`.

<details><summary>Slider and selection details</summary>

- A slider's text is sign, digits and an optional fraction, at most 15 significant digits, refused unwritten otherwise or out of range.
- A combo box whose list has never been opened exposes no items, so it is opened, the item selected and the list closed again. The selection is confirmed only after the close, once it still reads right 150 ms later, because an app's `DropDownClosed` handler runs after the close returns and can reset or commit it: in a standalone probe (no omp build loaded) a handler that resets the selection did so 20 of 20 times, 1–13 ms after the close, while an immediate read still showed the new item 16 of 20 times. A run that ends inside that window reports `AxUnconfirmed`.
- After a failure it attempts to close a list this call opened and reports the state it then reads, unless the window lost the foreground, when closing it would take the foreground back. A provider call that blocks past the caller's deadline gets `main`'s `Timeout`.
- A WPF control in a WinForms `ElementHost` is refused too: in a standalone UI Automation probe (no omp build loaded) its `RangeValue.SetValue` took the foreground on both Windows versions.
- Only items the list currently exposes are searched: a virtualized list's off-screen rows are not found, and the error says so.
- A missing `Value` pattern in `setValue` is named instead of the success text.

</details>

## Testing

`set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item` (ignored; needs a signed-in desktop) drives `AxSetValue` on a real WPF window. At `6f545b59b90` it passes 10 of 10 runs on Windows 10 and on Windows 11, and fails on both with the number and item route turned off.

<details><summary>What the live test covers</summary>

A slider number and a 16-significant-digit refusal, a never-opened combo's item (opened, selected, closed), a miss on a never-opened combo and on a previously opened, now closed one, a combo whose `DropDownClosed` handler resets the selection and one whose handler commits it only on close, a multiple-selection list whose prior selection is kept, the window losing the foreground once the list is open, and refusals with nothing sent behind another window and for a covered windowless WinForms button. The rebase onto `main` changed one import list (beside #20110's) and the `AxUnconfirmed` docs sentence, no logic.

In a tree merging this head with the other open natives PRs, the test (with rows a follow-up adds for windows behind others) also passes on a GitHub-hosted windows-latest runner (Windows Server 2025 24H2, build 26100.33828, interactive session).

</details>

Three unit tests pin these codes; each fails with its code reverted to `InputFailed`. At `766e314b82c` (the head's code) the live test and the desktop unit tests pass on a GitHub-hosted windows-latest runner.

`scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt pass on this branch's lines at `4b781b170a8`. `bun check` was not run: the diff is Rust and docs only.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


