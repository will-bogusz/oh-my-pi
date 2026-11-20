## What

On Windows a `computer` takeover could grab the foreground while I was in the middle of typing, and my keys went into the agent's target window instead of mine, so now it waits for me to pause and stops as soon as I press anything, the way it already works on macOS and X11.

On Windows 11, the packaged v19.0.1 build lost 90 characters from the user's window and activated the target's button 15 extra times while the user typed; this head lost none and made no extra button activations (40 calls per build: 20 default and 20 `takeover: true`). The default-route key-event anomaly below remains under investigation.

| Windows 11, user typing, head f6a4155c9d6 | v19.0.1 | this PR |
|---|---|---|
| Default and `takeover: true`, 40 calls per build | 90 missing user characters; 15 extra button activations | 0 missing characters; 0 extra activations |
| User idle for 6 s | Click median 253 ms; type 446.5 ms | Click median 263.5 ms; type 443 ms |

> **Windows context.** A takeover brings the target to the front and sends real input, so every key the user presses meanwhile goes to the target. Windows decides call by call whether a process may take the foreground, without saying why. On our Windows 10 guest every call was refused until OMP had once clicked the target app while it was already in front; after that, takeovers went through while the user typed. So users see refusals first, then takeovers mid-typing.

**What watches the user, and when.** It listens only while a takeover call runs, counts presses and the time of the last one, and reads no keys or positions: a Raw Input registration made when the call's admission starts and removed (`RIDEV_REMOVE`) when the call returns, by a guard in the native call scope, so errors, cancels and panics remove it too. OMP's own `SendInput` input has no device and never counts. No hook is added; `main`'s `WH_KEYBOARD_LL` Escape monitor is unchanged (per takeover call, Escape only).

## Why

- **Admission, as on macOS and X11:** the call waits until the user has pressed nothing for 5 s and holds no button or modifier, up to the deadline, else fails with `UserIntervened` having sent nothing.
- **During the takeover:** each input batch, hold, settle and drain checks the count; a press stops the call with `UserIntervened`, releases what it held and hands the user's window back. The stopping key has landed: one key per intervention. Interrupted typing drops the text not yet sent, never sends it later, and says how many characters went out and that the target was not seen reading them; a release or hand-back Windows refused stays in the same error.
- **Embedding hosts:** Windows allows one keyboard and one mouse Raw Input registration per process. If the process already has one, OMP leaves it alone (never replaces or removes it) and watches `GetLastInputInfo` instead, which cannot tell input apart, so any input counts; the call's output says so. Teardown removes only registrations that still target OMP's own window.
- **Cost:** a call Windows will refuse now waits for the pause first. In these Windows 11 typing runs, click medians rose from 218–232.5 ms to 6365.5–6374.5 ms; type medians from 467.5–511 ms to 6346–6369.5 ms. Activating first would send the user's keys to the target while waiting.

<details><summary>Reading order, known gaps, maintenance</summary>

- Read `win32/activity.rs` (`UserActivity::admit`, `start`, `check`, `is_user_press`), then the gates in `win32/input.rs` (`ForegroundGuard`, `send_to`, the drain and settle waits).
- While a call runs, Raw Input costs one message per input event (pointer moves included) to its listener thread; between calls nothing is registered. Overlapping sessions share one registration. The quiet time before it exists comes from `GetLastInputInfo`, minus OMP's own send windows.
- Touchpad and touchscreen presses arrive without a device and go unseen; a virtual HID device's keys count as the user's; a `WM_INPUT` still queued can be overtaken by the call's last send. `GetLastInputInfo` counts other programs' injected input as the user's (a longer wait) and an injected old timestamp can make the user look idle earlier; a send window wider than 50 ms suppresses nothing. If Windows fails to remove the registration, takeovers are refused until OMP restarts.
- A press that arrives after all the text went out gets the generic `UserIntervened`, with the unconfirmed reason when one was known.
- Windows cannot check and change a Raw Input registration in one step: a host registering in the instant between OMP's check and its registration or removal can still lose its own. In polling mode a send of OMP's that took over 50 ms counts as the user's.
- A press that stopped one takeover still holds the next one 5 s from it: the last press time outlives the listener, so OMP's own cleanup release, often the session's newest input, cannot hide it.
- The `SendInput` exclusion relies on Raw Input naming no device for injected input, which Windows does not document. If that changed, OMP's own input would stop every takeover with `UserIntervened`, so the first takeover after such an update shows it.
- Windows 11 guest procedure: before each call the OMP process was restarted. One baseline idle-click trial whose layout left the target in front before the call is left out; the other cells retain all 10 trials.

</details>

## Testing

Windows 11 guest, v19.0.1 against this branch's head (f6a4155c9d6) and its addon, interleaved rounds; WPF target, user typing real QEMU input beside it. `takeover: true` rows are logged explicit takeovers.

| Windows 11, head f6a4155c9d6 (10 trials per action cell, except the excluded baseline idle click) | v19.0.1 | this PR |
|---|---|---|
| User typing, default mode | 43 target key events; 48 missing user characters; 9 extra button activations | 10 target key events; 0 missing characters; 0 extra activations |
| User typing, `takeover: true` | 40 target key events; 42 missing user characters; 6 extra button activations | 0 target key events; 0 missing characters; 0 extra activations |
| User idle | 17/19 foreground takeovers; click/type medians 253/446.5 ms | 17/20 foreground takeovers; click/type medians 263.5/443 ms |

The 10 remaining default-mode key events are in four click trials: three precede the input call, five occur between call start and the first target-foreground transition, and two follow that transition. The same call-start-to-first-foreground interval contains no key events in nine trace-valid v19.0.1 trials (one never activated). The cause is open; these are not claimed as an unconditional zero.

One idle click's post-action state request timed out, so that reported-success call's target effect is unverified. Build-hash attestation was not available for these runs: hash not recorded on either side.

At f6a4155c9d6 on Windows 11: all 12 activity tests, all 8 foreground-input tests and all 6 ignored windowed takeover tests passed. All six targeted regressions failed in a same-head mutant reverting their six fix sites. Reverting only the windowed fixture's `admitted_backend` setup made all six windowed tests fail.

`rust-check` passed on Linux, macOS and the Windows MSVC target. The TypeScript polling-notice unit test passed (1 test, 8 assertions). No prompt eval was run.

<details><summary>Unit detail</summary>

Admission, press classification, own-send history and tick wrap, a stale admission, register/remove balance on success, refusal, cancel, early error and panic with fake registrations and with the real one; a press seen by one registration holding the next admission; a polled watch counting new input except OMP's own send and never moving the last press back; a host's real keyboard registration left in place (the watch polls) and a receiver registered during a call kept at teardown; a failed release kept under `UserIntervened`; interrupted typing's counts, including part of a character; the activation fence skipped once the target is in front.

</details>

