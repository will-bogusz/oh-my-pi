## What

On Windows a `computer` takeover could grab the foreground while I was in the middle of typing, and my keys went into the agent's target window instead of mine, so now it waits for me to pause and stops as soon as I press anything, the way it already works on macOS and X11.

With the user typing when a takeover starts on Windows 11, the user's keys reaching the target go from 283 in 120 calls to 0 in 118, and their Space pressing the target's button from 49 times to 0.

| Windows 11, user in their own window | `main` (v19.0.1) | this PR |
|---|---|---|
| User typing as the call starts (default and `takeover: true`; 120 calls on `main`, 118 here) | runs at once (median 0.2-0.5 s); user loses a median 2-4 keys; 283 key events reach the target; Space presses the target's button 49 times | waits until the user pauses, then runs (median 6.4 s); 0 keys lost, 0 reach the target, 0 presses |
| User starts typing 50 ms into a takeover typing a long line (15 calls) | typing runs on; 44 of the user's characters land in the target | stops with `UserIntervened` at the first key (11 of 15; 3 finished before any key); 1 key lands in the target, then the user's window is back |
| User idle for 6 s (30 calls) | click 0.26 s, type 0.46 s (median) | 0.27 s, 0.45 s: no added wait |

> **Windows context.** A takeover brings the target to the front with `SetForegroundWindow` and sends real input, so every key the user presses meanwhile goes to the target. Windows decides call by call whether a process may take the foreground, without saying why. On our Windows 10 guest every call was refused until OMP had once clicked the target app while it was already in front; after that, takeovers went through while the user typed. So users see refusals first, then takeovers mid-typing.

**How it watches the user.** A Raw Input listener, one per process, counts key, button and wheel presses that come from an input device and keeps only the count and the time of the last one: no key codes, no pointer positions. `SendInput` input, OMP's own included, has no device and never counts. It is not a hook, so Windows never waits on it. The only low-level hook, the existing `WH_KEYBOARD_LL` Escape monitor, is unchanged.

## Why

- **Admission, as on macOS and X11:** before the target comes forward the call waits until the user has pressed nothing for 5 s and holds no button or modifier, up to the run's deadline; still active then, it fails with `UserIntervened` and sends nothing.
- **During the takeover:** every input batch, hold, settle and the wait for typed text checks the count; a press stops the call with `UserIntervened`, releases what it held and hands the user's window back.
- **Rejected:** a `WH_MOUSE_LL` hook, which sits in every program's input path.

<details><summary>Reading order, known gaps, maintenance</summary>

- Read `win32/activity.rs` (`UserActivity::admit`, `start`, `check`, `is_user_press`), then the gates in `win32/input.rs` (`ForegroundGuard`, `send_to`, the drain and settle waits).
- Raw Input costs one message per input event (pointer moves included) to OMP's listener thread while a session lives.
- Touchpad and touchscreen presses arrive without a device and go unseen; a virtual HID device's keys count as the user's; a `WM_INPUT` still queued can be overtaken by the call's last send; the first call of a session reads the time before the listener started from `GetLastInputInfo`, which counts injected input too.
- The `SendInput` exclusion relies on Raw Input naming no device for injected input, which Windows does not document. If that changed, OMP's own input would stop every takeover with `UserIntervened`, so the first takeover after such an update shows it.
- Windows 11 guest procedure: before each call the OMP process was restarted, the procedure in which this guest let it take the foreground (with OMP's own injected key first, it refused). Two calls whose layout left the target in front before the call are left out.

</details>

## Testing

Windows 11 guest, v19.0.1 against this branch's addon, three interleaved rounds; WPF target, the user is real QEMU input into a WinForms window beside it. The `takeover: true` rows are logged explicit takeovers, so admission is not skipped for them.

Windows 10 refused every takeover with the user typing on both builds, so it shows only that nothing else changed (idle: 6 of 8 ran on each). One cost: a call Windows will refuse now waits for the pause first (median 0.5 s to 6.8 s).

The admission and press-classification tests in `win32/activity.rs` pass on Windows 11. The windowed takeover tests now wait out the key or click that started them (`admitted_backend`), as the worker does; on these guests Windows then refused the target's activation in every windowed test, `main`'s own included, so they did not run to the end here. No test can press a key from a device, so the cells are the before/after evidence. The `UserIntervened` line in the `computer` prompt gains the word Windows; no eval was run for it.
