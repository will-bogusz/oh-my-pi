## What

On Windows a `computer` takeover could grab the foreground while I was in the middle of typing, and my keys went into the agent's target window instead of mine, so now it waits for me to pause and stops as soon as I press anything, the way it already works on macOS and X11.

The results retain the earlier, unexplained default-route key-event anomaly.

| Windows 11, user typing, head f6a4155c9d6 | v19.0.1 | this PR |
|---|---|---|
| Default and `takeover: true`, 40 calls per build | 90 missing user characters; 15 extra button activations | 0 missing characters; 0 extra activations |
| User idle for 6 s | Click median 253 ms; type 446.5 ms | Click median 263.5 ms; type 443 ms |


A call-scoped Raw Input listener counts presses, not keys or positions. Admission waits for quiet; delivery checks for intervention.

## Why

- Admission waits for 5 s without presses or held buttons/modifiers, bounded by the deadline; a timeout returns `UserIntervened` without input.
- A press during takeover stops the remaining input and hands focus back. Its stopping key has already landed. The error retains sent-character counts, unconfirmed consumption and release/hand-back failures.
- Existing or unlistable Raw Input registrations select last-input polling: pointer moves and injected input may count; own-send windows are excluded and may hide coincident user input.
- Even a Windows-refused call waits for quiet. Typing-run click/type medians rose from 218–511 ms to 6346–6374.5 ms; activating first would divert keys while waiting.

<details><summary>Reading order, known gaps, maintenance</summary>
> **Windows context.** A takeover brings the target to the front and sends real input, so every key the user presses meanwhile goes to the target. Windows decides call by call whether a process may take the foreground, without saying why. On our Windows 10 guest every call was refused until OMP had once clicked the target app while it was already in front; after that, takeovers went through while the user typed. So users see refusals first, then takeovers mid-typing.

- Read `win32/activity.rs` (`UserActivity::admit`, `start`, `check`, `is_user_press`), then the gates in `win32/input.rs` (`ForegroundGuard`, `send_to`, the drain and settle waits).
**What watches the user, and when.** It listens only while a takeover call runs, counts presses and the time of the last one, and reads no keys or positions: a Raw Input registration made when the call's admission starts and removed (`RIDEV_REMOVE`) when the call returns, by a guard in the native call scope, so errors, cancels and panics remove it too. OMP's own `SendInput` input has no device and never counts. No hook is added; `main`'s `WH_KEYBOARD_LL` Escape monitor is unchanged (per takeover call, Escape only).
- While a call runs, Raw Input costs one message per input event (pointer moves included) to its listener thread; between calls nothing is registered. Overlapping sessions share one registration. The quiet time before it exists comes from `GetLastInputInfo`, minus OMP's own send windows.
- Touchpad and touchscreen presses arrive without a device and go unseen; a virtual HID device's keys count as the user's; a `WM_INPUT` still queued can be overtaken by the call's last send. `GetLastInputInfo` counts other programs' injected input as the user's (a longer wait) and an injected old timestamp can make the user look idle earlier; a send window wider than 50 ms suppresses nothing. If Windows fails to remove the registration, takeovers are refused until OMP restarts.
- A press after the drain ended gets the generic `UserIntervened`, with the unconfirmed reason when one was known.
- Windows cannot check and change a Raw Input registration in one step: a host registering in the instant between OMP's check and its registration or removal can still lose its own. In polling mode a send of OMP's that took over 50 ms counts as the user's.
- Losing or being unable to list the live listener's registrations stops the call without inventing a user press; an overlapping admission cannot reuse that blind watch.
- A press that stopped one takeover still holds the next one 5 s from it: the last press time outlives the listener, so OMP's own cleanup release, often the session's newest input, cannot hide it.
- The `SendInput` exclusion relies on Raw Input naming no device for injected input, which Windows does not document. If that changed, OMP's own input would stop every takeover with `UserIntervened`, so the first takeover after such an update shows it.
- Windows 11 guest procedure: before each call the OMP process was restarted. One baseline idle-click trial whose layout left the target in front before the call is left out; the other cells retain all 10 trials.

</details>

## Testing

Historical Windows 11 guest runs: v19.0.1 against f6a4155c9d6 and its addon, interleaved rounds; WPF target, user typing real QEMU input in their own window. `takeover: true` rows are explicit takeovers.

Admission-disabled before-state, same head, debug builds: 20 default click calls lost 18 user characters in 18 calls; the unchanged control lost none in 20. Captured target keydowns followed foreground activation: without the wait, the user's next key lands there before intervention stops delivery.

| Windows 11, head f6a4155c9d6 (10 trials per action cell, except the excluded baseline idle click) | v19.0.1 | this PR |
|---|---|---|
| User typing, default mode | 43 target key events; 48 missing user characters; 9 extra button activations | 10 target key events; 0 missing characters; 0 extra activations |
| User typing, `takeover: true` | 40 target key events; 42 missing user characters; 6 extra button activations | 0 target key events; 0 missing characters; 0 extra activations |
| User idle | 17/19 foreground takeovers; click/type medians 253/446.5 ms | 17/20 foreground takeovers; click/type medians 263.5/443 ms |

One idle click in the original interleaved table had a post-action state request time out, so that reported-success call's target effect is unverified. Build-hash attestation was not available for that table: hash not recorded on either side.

The six historical windowed cases use a fixture foreground grant: allowed delivery/drain, not physical intervention or unassisted activation.

`rust-check` passed on Linux, Windows MSVC and macOS at this head. Live checks below are at f6a4155c9d6 and were not repeated after review corrections. The prompt's `UserIntervened` sentence now names Windows; no instruction changed, no model sample run. No test covers the order of the two reads in `Sample::read`: that needs a clock seam the code lacks.

<details><summary>The earlier key-event anomaly</summary>

One earlier 10-trial default click run logged five target key events in three trials between input-call start and first recorded target foreground. Three other events preceded the call; two followed activation. Sixty later trials across three builds (unchanged debug, polling-fallback debug, unchanged release/original WPF) on verified transport logged no target key events and lost no user text; 53 had an observed target-foreground transition, seven did not. The earlier harness silently accepted failed input commands (now fixed); the cause is unestablished, not an unconditional-zero claim.

</details>

<details><summary>Unit detail</summary>

At f6a4155c9d6 the TypeScript polling-notice unit passed (1 test, 8 assertions); its later assertion change has not been run.

At 0cb0303d6c5 (later commits only rename or move test code) on Windows 11, `desktop::win32::` passed 60 with 7 ignored, and each of the 6 ignored windowed takeover tests passed run alone. Six guard controls, each run in a fresh process, pass on this head and fail with their fix reverted: a receiver taken during a takeover, a host's own registration left in place, the polling watch's wording, a press while typing (reverted twice: accepted-prefix accounting and error recreation), and the kept failure suffix.


At f6a4155c9d6 on Windows 11: all 12 activity tests, all 8 foreground-input tests and all 6 ignored windowed takeover tests passed. All six targeted regressions failed in a same-head mutant reverting their six fix sites. Reverting only the windowed fixture's `admitted_backend` setup made all six windowed tests fail.

Admission, press classification, own-send history and tick wrap, a stale admission, register/remove balance on success, refusal, cancel, early error and panic with fake registrations and with the real one; a press seen by one registration holding the next admission; a polled watch counting new input except OMP's own send and never moving the last press back; a host's real keyboard registration left in place (the watch polls) and a receiver registered during a call kept at teardown; a failed release kept under `UserIntervened`; interrupted typing's counts, including part of a character; the activation fence skipped once the target is in front.

</details>

