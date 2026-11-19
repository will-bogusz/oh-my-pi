## What

On Windows, pressing a plain button pulled its app in front of me, and clicking one while I worked elsewhere said it worked when nothing was clicked. Both now click the button in the background and say ok only once the button has answered its click message.

WinForms button behind your window: `click()` **reported success with nothing clicked in 19 of 20 trials on v19.0.0 → 0 of 20**; `press()` on a button or check box took your foreground in 60 of 60 → 0 of 60.

> **Windows context.** A classic button (the system `BUTTON` control, used by Win32 dialogs and every WinForms `Button` and `CheckBox`) is its own small window. `BM_CLICK` makes the button run its own click before the message returns, with no activation. UI Automation's `Invoke` activates the window first; a posted press and release is often dropped.

| WinForms button or check box | v19.0.0 | This PR |
|---|---|---|
| `press()`, its app in front | clicked (20/20) | clicked (18/20; 2 app stalls) |
| `press()`, you idle in another window or it is covered | clicked, its app raised over yours (40/40) | clicked, nothing raised (40/40) |
| `press()`, you typing elsewhere | your keys land in the app, 385 of 600, and a Space presses the button again (20/20) | clicked once, 0 of 600 keys lost (20/20) |
| `click()` on the button, covered or you typing | `ok`, nothing clicked (19/20; 1 app stall) | clicked (18/20; 2 app stalls) |
| a check box that does not change | `ok` | native auto box: `InputFailed`; WinForms box, through `press()`: `AxUnconfirmed` (its app may manage the state) |
| `press()` on a button whose form is disabled behind a dialog | Invoke tried | refused, nothing sent |

Reading order: `window::native_button` and `window::click_button`, then their callers in `win32/ax.rs` and `win32/input.rs`.

## Why

Refs #16572, which reported both on WinForms. Related: #16573 refuses these actions (sending them to takeover); this keeps them in the background.

Decisions:
- `BM_CLICK` is sent and waited for (at most 3 s, never past the operation's deadline), not posted. A send Windows refused is `InputFailed`, nothing clicked; one unanswered in time (a handler that opened a dialog) is `InputFailed` worded as possibly taken, never ok.
- A native automatic check box must read a changed state after the click; a WinForms one, via `press()`, is read through UI Automation's Toggle state.
- A button disabled up to its top-level window (a form behind its modal dialog), checked again just before the send, is refused with nothing sent; so is a check box whose Toggle state cannot be read. A higher-integrity app gets the existing UIPI refusal.

Limits:
- A push button's ok means its click message was delivered and answered, not that the app acted, as with main's `Invoke`.
- A single unmodified left background `click()` on a WinForms or system Win32 button becomes the button's own click message, not a pointer press at the point; WinForms `MouseDown`/`MouseUp` handlers do not run, so a button acting on `MouseDown` needs takeover. Owner-drawn system Win32 buttons keep the click at the point.

Maintenance: documented button messages, stable since Windows NT.

## Testing

The table is OMP's `press()` and `click()` through the public `computer` route on a Windows 10 22H2 VM, v19.0.0's published addon against this branch's release build, n=10 per condition. Without OMP, `BM_CLICK` acted 6/6 with no foreground change; `Invoke` took the foreground 6/6.

<details><summary>Rig, the user's own text, the button test, dialogs</summary>

The WinForms app and a simulated user typing through the VM's USB keyboard into a window of its own; the foreground recorded by a WinEvent hook; the app's own counters as truth; `computer` in its default mode. An app stall is the test app not answering the harness for 5 s after the call returned ok; it counts as not clicked. Across the same 160 WinForms trials (this PR's cells and the edit fix's), this branch had 5 stalls and 1 failed state read, v19.0.0 1. An interleaved check on WinForms set, press and click (unfocused and typing, n=60 per cell per build) found 3 of 178 on v19.0.0 and 4 of 179 on this branch (set 1/60 each; press/click 2/118 vs 3/119). Wait-chain snapshots of the stalled app showed no thread waiting on a sent message, lock, COM or ALPC call, and no OMP thread blocked: the state read timed out while the app idled. In refuse mode (n=5 per cell, unfocused, typing, covered), v19.0.0 raised the app in 44 of 44 `press()`/`setValue` trials; this branch in 0 of 45, all clicked or written but one stalled `click()`. WPF buttons (n=5) behave as on v19.0.0: clicked in front, refused behind.

The user's window was read before and after every trial. On v19.0.0, every `press()` trial while the user typed (20/20) ended with keys missing from the user's text. On this branch, 0 of 160 trials changed the user's text other than by the user's own typing.

`button_clicks_land_before_returning_and_unchanged_check_boxes_fail` pumps no messages, so `BN_CLICKED` must arrive before `click_button` returns (a posted `BM_CLICK` fails it); it also covers a refused check box, a parent disabled while the button's state is read (no click sent), and a Win32 owner-drawn button kept on the positional click.

Dialogs are not excluded: `BM_CLICK` "may fail" in an inactive dialog per its docs, yet it closed an inactive Windows 10 message box 6/6 without taking the foreground.

</details>

- `natives-test.exe desktop::win32::` on the VM: 44 passed.
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS: clippy and rustfmt clean on the branch's lines.

Not run: behaviour on macOS and Linux (the change is Windows-only; they were compiled and linted).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
