## What

On Windows, pressing a plain button pulled its app in front of me, and clicking one while I worked elsewhere said it worked when nothing was clicked. Both now click the button in the background and say ok only once the button has answered its click message.

WinForms button behind your window: `click()` **reported success with nothing clicked in 19 of 20 trials on v19.0.0 → none (19 clicked, 1 unverified)**; `press()` on a button or check box took your foreground in 60 of 60 → 0 of 60.

> **Windows context.** A classic button (the system `BUTTON` control: Win32 dialogs, WinForms `Button`, `CheckBox`, `RadioButton`) is its own small window. `BM_CLICK` runs its click before returning, with no activation; UI Automation's `Invoke` activates the window first, and a posted press is often dropped.

| WinForms button or check box | v19.0.0 | This PR |
|---|---|---|
| `press()`, its app in front | clicked (20/20) | clicked (19/19) |
| `press()`, you idle in another window or it is covered | clicked, its app raised over yours (39/40 clicked, 1 unverified; raised 40/40) | clicked, nothing raised (39/40; 1 unverified) |
| `press()`, you typing elsewhere | your keys land in the app: 396 of 600 lost from your text, and a Space presses it again (20/20) | clicked, 0 of 600 keys lost (18/20; 2 unverified) |
| `click()` on the button, covered or you typing | `ok`, nothing clicked (19/20; 1 unverified) | clicked (19/20; 1 unverified) |
| a check box that does not change | `ok` | native auto box: `InputFailed`; WinForms box, through `press()`: `AxUnconfirmed` (its app may manage the state) |
| a button disabled behind a dialog, or moved to another window | Invoke tried | refused, nothing sent |

*Unverified*: the harness could not read the app's state within 5 s of the ok; the outcome is unknown.

Reading order: `window::native_button`, `window::click_button`, then their callers in `ax.rs` and `input.rs`.

## Why

Refs #16572, which reported both on WinForms. Related: #16573 sends these actions to takeover; this keeps them in the background.

Decisions:
- `BM_CLICK` is sent and waited for (at most 3 s, within the operation's deadline), not posted. Refused: `InputFailed`, nothing clicked; unanswered in time: `InputFailed`, possibly taken.
- An automatic check box must read a changed state after the click (Toggle for WinForms); one gone before the read is possibly clicked.
- Just before the send the button must still be enabled up to, and inside, the top-level window it was found in.
- An explicit `invoke` looks up the `Invoke` pattern once; a failed lookup is main's error, never a retry reaching `Invoke`.

Limits:
- A push button's ok means its click message was answered, not that the app acted, as with main's `Invoke`.
- A single unmodified left background `click()` on a button becomes its click message, not a press at the point: WinForms `MouseDown`/`MouseUp` handlers do not run, and a WinForms radio is selected even if validation would cancel a mouse click. Owner-drawn system buttons keep the point.
- With #19871 also in `main`, this BM_CLICK route must mark dispatch too; that line is ready as win-button-click-fence.

Maintenance: documented button messages, stable since Windows NT.

## Testing

Above: `press()` and `click()` through the public `computer` route on a Windows 10 22H2 VM, v19.0.0's addon against this branch's release build (`f80f77bb012`; the rebase onto `725f8c6f34` left the diff unchanged), n=10. Windows 11 25H2, addon hash read back per side, n=5:

| WinForms button or check box, Windows 11 | v19.0.0 | This PR |
|---|---|---|
| `press()` in the background: foreground taken | 30/30 | 0/30, clicked 30/30 |
| `press()`, you typing: your keys lost | 179 of 300 | 0 of 300 |
| `click()`, covered or you typing | `ok`, nothing clicked (9/10; 1 unverified) | clicked (10/10) |
| `press()`/`click()`, its app in front | clicked (15/15) | clicked (15/15) |

<details><summary>Rig, the user's own text, the unit tests, dialogs</summary>

The WinForms app and a simulated user typing through the VM's USB keyboard into a window of its own; the foreground recorded by a WinEvent hook; the app's own counters as truth; `computer` in its default mode. The user's window was read before and after every trial: on v19.0.0 every `press()` trial while the user typed (20/20) lost keys from the user's text; on this head none of the 120 trials changed it other than by the user's own typing.

Unit tests, each failing with its guard reverted: the button fixture pumps no messages, so `BN_CLICKED` must arrive before `click_button` returns; its rows refuse an unchanged check box, a form disabled while the state is read, a button moved into another window while its state is read (no `BM_CLICK` sent), and a box that destroys itself on its click (not ok). `native_buttons_are_pressed_by_their_click_message_and_never_behind_a_dialog` drives `perform` through UI Automation and fails if the button route is removed; `left_clicks_send_buttons_their_click_except_owner_drawn_system_buttons` drives the background pointer route and fails if the hand-off is removed or an owner-drawn button gets `BM_CLICK`.

Two app checks on the VM, n=3 each: a WinForms button whose provider fails two Invoke lookups in a row (UI Automation retries one itself) made the pre-fix branch call `Invoke` and take the foreground; this head and v19.0.0 return `AxFailed` without invoking. A hidden WinForms radio button held by an earlier ref is checked by `press()` on v19.0.0 too (.NET Framework 4.8 and .NET 8 builds), with the foreground taken there and not here.

Dialogs are not excluded: `BM_CLICK` "may fail" in an inactive dialog per its docs, yet it closed an inactive Windows 10 message box 6/6 without taking the foreground.

Without OMP, `BM_CLICK` acted 6/6 with no foreground change; `Invoke` took the foreground 6/6. Over ssh (session 0, no desktop) the unit run's one failure is main's `a_chromium_window_is_marked_only_when_nothing_of_it_shows`, untouched here.

</details>

- `natives-test.exe desktop::win32::` at `f80f77bb012` on each VM's desktop session: 47 passed, 7 ignored on Windows 10 and on Windows 11.
- `scripts/rust-check` on Windows (cargo-xwin), Linux and macOS at `f80f77bb012`: clippy and rustfmt clean on the branch's lines.

Not run: behaviour on macOS and Linux (the change is Windows-only; they were compiled and linted).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
