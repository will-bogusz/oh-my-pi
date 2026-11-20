## What

On Windows a `computer` takeover could grab the foreground while I was in the middle of typing, and my keys went into the agent's target window instead of mine, so now it waits for me to pause and stops as soon as I press anything, the way it already works on macOS and X11.

On Windows 11 with the user typing, their keys reaching the target go from 283 in 120 calls to 0 in 118, and Space presses of the target's button from 49 to 0.

| Windows 11, user in their own window | `main` (v19.0.1) | this PR |
|---|---|---|
| User typing as the call starts (default and `takeover: true`; 120 calls on `main`, 118 here) | runs at once (median 0.2-0.5 s); user loses a median 2-4 keys; 283 key events reach the target; Space presses the target's button 49 times | waits until the user pauses, then runs (median 6.4 s); 0 keys lost, 0 reach the target, 0 presses |
| User starts typing 50 ms into a takeover typing a long line (15 calls) | typing runs on; 44 of the user's characters land in the target | stops with `UserIntervened` at the user's first key (11 of 15; 3 finished before any key, 1 refused by Windows); that one key lands in the target, then the user's window is back |
| User idle for 6 s (30 calls) | click 0.26 s, type 0.46 s (median) | 0.27 s, 0.45 s: no added wait |

> **Windows context.** A takeover brings the target to the front and sends real input, so every key the user presses meanwhile goes to the target. Windows decides call by call whether a process may take the foreground, without saying why. On our Windows 10 guest every call was refused until OMP had once clicked the target app while it was already in front; after that, takeovers went through while the user typed. So users see refusals first, then takeovers mid-typing.

**What watches the user, and when.** Nothing reads what is typed. New: a Raw Input listener, registered with the process's first `computer` session for the process's life (Windows allows one per process), counts key, button and wheel presses from input devices and keeps only the count and the last one's time. OMP's own `SendInput` input has no device and never counts. It is not a hook; no mouse hook is added. The only low-level hook stays `main`'s `WH_KEYBOARD_LL` Escape monitor: installed per takeover call, removed after it, looking only at Escape.

## Why

- **Admission, as on macOS and X11:** the call waits until the user has pressed nothing for 5 s and holds no button or modifier, up to the deadline, else fails with `UserIntervened` having sent nothing.
- **During the takeover:** each input batch, hold, settle and drain checks the count; a press stops the call with `UserIntervened`, releases what it held and hands the user's window back. The stopping key has landed: one key per intervention.
- **Limit:** a call Windows will refuse now waits for the pause first (Windows 10: median 0.5 s to 6.8 s). Nothing we measured predicts a refusal; activating first would send the user's keys to the target while waiting.

<details><summary>Reading order, known gaps, maintenance</summary>

- Read `win32/activity.rs` (`UserActivity::admit`, `start`, `check`, `is_user_press`), then the gates in `win32/input.rs` (`ForegroundGuard`, `send_to`, the drain and settle waits).
- Raw Input costs one message per input event (pointer moves included) to OMP's listener thread while a session lives.
- Touchpad and touchscreen presses arrive without a device and go unseen; a virtual HID device's keys count as the user's; a `WM_INPUT` still queued can be overtaken by the call's last send; the first call of a session reads the time before the listener started from `GetLastInputInfo`, which counts injected input too.
- The `SendInput` exclusion relies on Raw Input naming no device for injected input, which Windows does not document. If that changed, OMP's own input would stop every takeover with `UserIntervened`, so the first takeover after such an update shows it.
- Windows 11 guest procedure: before each call the OMP process was restarted, the procedure in which this guest let it take the foreground (with OMP's own injected key first, it refused). Two calls whose layout left the target in front before the call are left out.

</details>

## Testing

Windows 11 guest, v19.0.1 against this branch's addon, three interleaved rounds; WPF target, user typing real QEMU input in a window beside it. The `takeover: true` rows are logged explicit takeovers: admission is not skipped.

Windows 10 refused every takeover with the user typing on both builds, so it only shows nothing else changed (idle: 6 of 8 ran each).

Unit level (injected clock): the admission and press-classification tests in `win32/activity.rs` pass on Windows 11; they test new code. Live: no windowed takeover test runs to its end on these guests, `main`'s included (Windows refuses the test's activation), so this PR's change to them (`admitted_backend` waits out the click that started the test) is unverified; the cells are the evidence. The prompt's `UserIntervened` line gains the word Windows; no eval was run.
