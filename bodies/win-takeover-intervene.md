## What

On Windows a `computer` takeover could grab the foreground while I was in the middle of typing, and my keys went into the agent's target window instead of mine, so now it waits for me to pause and stops as soon as I press anything, the way it already works on macOS and X11.

On Windows 11 with the user typing, their keys reaching the target go from 283 in 120 calls to 0 in 118, and Space presses of the target's button from 49 to 0.

| Windows 11, user in their own window | `main` (v19.0.1) | this PR |
|---|---|---|
| User typing as the call starts (default and `takeover: true`; 120 calls on `main`, 118 here) | runs at once (median 0.2-0.5 s); user loses a median 2-4 keys; 283 key events reach the target; Space presses the target's button 49 times | waits until the user pauses, then runs (median 6.4 s); 0 keys lost, 0 reach the target, 0 presses |
| User starts typing 50 ms into a takeover typing a long line (15 calls) | typing runs on; 44 of the user's characters land in the target | stops with `UserIntervened` at the user's first key (11 of 15; 3 finished before any key, 1 refused by Windows); that one key lands in the target, then the user's window is back |
| User idle for 6 s (30 calls) | click 0.26 s, type 0.46 s (median) | 0.27 s, 0.45 s: no added wait |

> **Windows context.** A takeover brings the target to the front and sends real input, so every key the user presses meanwhile goes to the target. Windows decides call by call whether a process may take the foreground, without saying why. On our Windows 10 guest every call was refused until OMP had once clicked the target app while it was already in front; after that, takeovers went through while the user typed. So users see refusals first, then takeovers mid-typing.

**What watches the user, and when.** It listens only while a takeover call runs, counts presses and the time of the last one, and reads no keys or positions: a Raw Input registration made when the call's admission starts and removed (`RIDEV_REMOVE`) when the call returns, by a guard in the native call scope, so errors, cancels and panics remove it too. OMP's own `SendInput` input has no device and never counts. No hook is added; `main`'s `WH_KEYBOARD_LL` Escape monitor is unchanged (per takeover call, Escape only).

## Why

- **Admission, as on macOS and X11:** the call waits until the user has pressed nothing for 5 s and holds no button or modifier, up to the deadline, else fails with `UserIntervened` having sent nothing.
- **During the takeover:** each input batch, hold, settle and drain checks the count; a press stops the call with `UserIntervened`, releases what it held and hands the user's window back. The stopping key has landed: one key per intervention.
- **Limit:** a call Windows will refuse now waits for the pause first (Windows 10: median 0.5 s to 6.8 s). Nothing we measured predicts a refusal; activating first would send the user's keys to the target while waiting.

<details><summary>Reading order, known gaps, maintenance</summary>

- Read `win32/activity.rs` (`UserActivity::admit`, `start`, `check`, `is_user_press`), then the gates in `win32/input.rs` (`ForegroundGuard`, `send_to`, the drain and settle waits).
- While a call runs, Raw Input costs one message per input event (pointer moves included) to its listener thread; between calls nothing is registered. Overlapping sessions share one registration. The quiet time before it exists comes from `GetLastInputInfo`, minus OMP's own send windows.
- Touchpad and touchscreen presses arrive without a device and go unseen; a virtual HID device's keys count as the user's; a `WM_INPUT` still queued can be overtaken by the call's last send. `GetLastInputInfo` counts other programs' injected input as the user's (a longer wait) and an injected old timestamp can make the user look idle earlier; a send window wider than 50 ms suppresses nothing. If Windows fails to remove the registration, takeovers are refused until OMP restarts.
- The `SendInput` exclusion relies on Raw Input naming no device for injected input, which Windows does not document. If that changed, OMP's own input would stop every takeover with `UserIntervened`, so the first takeover after such an update shows it.
- Windows 11 guest procedure: before each call the OMP process was restarted, the procedure in which this guest let it take the foreground (with OMP's own injected key first, it refused). Two calls whose layout left the target in front before the call are left out.

</details>

## Testing

Windows 11 guest, v19.0.1 against this branch's addon, interleaved rounds; WPF target, user typing real QEMU input beside it. `takeover: true` rows are logged explicit takeovers. The first table is from the first version, which listened for the process's life; after scoping the listener to the call:

| Windows 11, listener scoped to the call (10 calls per cell) | `main` | this PR |
|---|---|---|
| User typing, default mode (20 calls) | 16 ran at once; 41 key events reach the target; Space presses its button 9 times | 19 ran after the pause (median 6.4 s); 0 keys lost, 0 in the target, 0 presses |
| User typing, `takeover: true` (20 calls) | 20 ran; 58 key events reach the target; 9 presses | 18 ran after the pause; 0, 0, 0 |
| User idle (20 calls) | click 0.25 s, type 0.44 s | 0.27 s, 0.42 s |

Windows 10 refused every takeover with the user typing on both builds in this procedure, so it only shows nothing else changed (idle: 6 of 8 ran each).

Unit, Windows 11: the 7 new tests in `win32/activity.rs` pass, including registration balance on every exit path with the real registration. The windowed takeover tests don't reach their end on these guests, `main`'s included (their window host never grants the test process the foreground), so this PR's change to them is unverified live. The prompt's `UserIntervened` line gains the word Windows; no eval was run.

<details><summary>Unit detail</summary>

Built at a056ab9fef0 (later commits: an error message and style). Admission, press classification, own-send history and tick wrap, a stale admission, and register/remove balance on success, refusal, cancel, early error and panic with fake registrations and with the real one (`GetRegisteredRawInputDevices` lists none after the last drop).

</details>
