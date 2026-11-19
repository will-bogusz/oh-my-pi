## What

On Windows, `setValue` on a plain text box pulled that app in front of whatever I was typing in, so my next keys went into its box. It now writes the text in the background with the text box's own messages.

`setValue` on a WinForms text box while you work in another window: **the app took your foreground in 30 of 30 trials on v19.0.0 → 0 of 30 with this PR**, and while you typed, 199 of your 300 keys went into its box → none. On Windows 10, `setValue` on Notepad goes from refused to written.

> **Windows context.** A classic text box (the system `EDIT` control, used by every WinForms `TextBox` and Windows 10 Notepad) is its own small window. UI Automation's built-in provider activates the app's window before setting its value; the control's own messages need neither focus nor activation.

| `setValue` on a classic text box | v19.0.0 | This PR |
|---|---|---|
| WinForms box, its app in front | written (10/10) | written (9/10; 1 unverified: the app's state read failed after its write event) |
| WinForms box, you idle in another window or it is covered | written, its app raised over yours (20/20) | written, nothing raised (19/20; 1 app stall) |
| WinForms box, you typing in another window | your keys land in its box, 199 of 300 (10/10) | written, your keys stay yours, 0 of 300 lost (10/10) |
| Windows 10 Notepad, in front | written (10/10) | written (10/10) |
| Windows 10 Notepad, not in front | refused: `BackgroundUnavailable … can take foreground` (30/30) | written, nothing raised (29/30; 1 unverified: the observer's read of Notepad's text timed out) |
| Rich edit, WPF, XAML and browser fields | unchanged | unchanged |

Reading order: `value_write::route` (which classes take the native route) → `value_write::set_edit` → `Win32Ax::set_value` in `win32/ax.rs`.

## Why

Refs #16572, which reported this on WinForms. Related: #16573 refuses these actions, which sends them to takeover; this PR keeps them in the background.

Decisions:
- `WM_SETTEXT` writes the whole value in one call and returns whether the box took it. A multi-line box sends no `EN_CHANGE` for it, so it is marked modified and its parent gets that one notification; if the box changed parent or ID meanwhile, the call reports the text written and the notification not sent. IP-address fields keep UI Automation.
- A plain box must read back exactly the text, or the call fails quoting what it holds; a password or possibly protected box is not quoted, and one that cannot be read keeps `WM_SETTEXT`'s answer.
- Disabled, read-only and length-limited boxes are refused before writing, and a digits-only box refuses letters, the rule UI Automation's own EDIT proxy applies; a higher-integrity app gets the existing UIPI refusal. A message waits at most 3 s and never past the operation's deadline; only a first send Windows refused counts as nothing written.

Limits: the old value cannot be undone with Ctrl+Z, and Notepad marks its document changed (its title gains `*` after each write, as after typing).

Maintenance: documented Win32 edit messages, unchanged since Windows NT.

## Testing

The table is OMP's own `setValue` through the public `computer` route on a Windows 10 22H2 VM (rig below), v19.0.0's published addon against this branch's release build, n=10 per condition, the foreground sampled throughout. Without OMP, `WM_SETTEXT` changed the WinForms box 6/6 and Notepad's 5/6 with no foreground change; UI Automation's `SetValue` took the foreground 6/6.

<details><summary>Rig, the user's own text, the edit test</summary>

A WinForms app and the inbox Notepad on the VM; a simulated user typing through the VM's USB keyboard into a window of its own; the foreground recorded by a WinEvent hook; the app's own state as truth; `computer` in its default mode. An app stall is the test app not answering the harness for 5 s after the call returned ok; it is restarted and the trial counted as not written. Across the same 160 WinForms trials (this PR's cells and the stacked button fix's), this branch had 5 stalls and 1 failed state read, v19.0.0 1; stalls also hit Notepad, read only by the observer (1 here).

The user's window was read before and after every trial. On v19.0.0, 10 of 10 typing trials ended with the user's text missing keys (on average 20 of 30). On this branch no trial changed the user's text other than by the user's own typing: 0 of 80 (WinForms and Notepad).

The edit test: `edit_values_are_written_without_focus_and_refused_when_read_only` writes a hidden single-line and multi-line edit without focus (exactly one `EN_CHANGE` each, both marked modified; without the parent notification the multi-line row fails with none), refuses a read-only one with nothing written, reports a mismatch without its text when protection is unknown, and for an app that ignores `WM_SETTEXT` reports its refusal, or, when it claims a write, the plain box's actual text even if it looks like a mask. Further rows: a subclass that reparents or detaches the edit during `WM_SETTEXT` (text written, no `EN_CHANGE`, partial delivery reported), an IP-address field kept on UI Automation, a refused first send leaving the text unchanged, and a digits-only box that takes `-12.5` and refuses `12a` with its value kept.

</details>

- `natives-test.exe desktop::win32::` on the Windows 10 VM: 44 passed.
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt clean on the branch's lines.

Not run: behaviour on macOS and Linux (the change is Windows-only; they were compiled and linted).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
