## What

When OMP needed a takeover on my Mac while I was still typing in another app, it pulled its target in front of me and my next keystrokes went into the agent's field, so a macOS takeover now waits until I've stopped typing for 5 seconds, the same rule X11 already has.

With a simulated person typing in their own front window, 89 of their keystrokes landed in the agent's field across 30 `el.type` calls on `main`; with this PR none did, and none went missing.

| Person typing in their own window, 10 calls each | `main` | this PR |
|---|---|---|
| WKWebView page field, `el.type` (falls back to a takeover) | 22 of their keys in the agent's field (5 calls), 5 refused | 0; waits for their pause (7.1 s), then the takeover fails `InputFailed` as it does on `main` with nobody typing |
| Safari page field, `el.type` | 22 keys (5 calls), 5 refused | 0; waits, then 9 fail as above, 1 typed |
| Chrome page, first `el.type` after launch | 45 keys (10 of 10 calls) | 0; 10 of 10 typed after their pause (7.1 s) |
| Takeover `type` while they pause 6 s mid-sentence | 10 of 10 typed (0.54 s; it ran while they had paused) | 10 of 10 typed once 5 s were quiet (4.5 s) |

**Cost:** a takeover that starts within 5 s of the person's last key or click waits out the rest of those 5 s: 4.5 s in the pause cell above, 3.3 s for a session whose listener starts while they are mid-pause, 7.1 s in the web cells (their typing runs about 2 s past the call). With nobody typing it waits nothing: a takeover right after a background click and key, or right after another takeover, took 521–530 ms against 529–545 ms on `main` (medians, AppKit and Chrome, 10 calls each), since OMP's own input never counts.

## Why

A takeover brings its target in front of the user's keyboard, so every key they type from then on lands in the target. On macOS the only wait before it was for the user's input into the target app itself: typing in their own app did not count. The background fallback's rerun (and any `takeover: true` call) therefore brought the target forward mid-sentence, and the takeover's monitor stopped the call at their first key, after that key had landed. #18784 said X11 lacked macOS's pause and interruption behaviour; macOS's pause covered only input into the target app, so this PR gives macOS the rule X11 got in #18784.

- **One rule for both platforms.** The quiet period and the refusal are one shared constant and one message (`control::USER_QUIET`, `control::still_active_refusal`), the 5 s X11 already uses; X11's behaviour is unchanged.
- **Only the person's own keyboard and pointer count** (CGEvent source pid 0, the takeover monitor's rule). Keys another program posts (a text expander, remote control, another agent) do not hold a takeover back, just as they do not stop a hand-back today; counting them would let any background typer block every takeover.
- **The wait happens before the input lease**, in the worker's admission as on X11, so another session's input is not held up meanwhile; it is rechecked under the lease and again as the takeover starts, and a press in between refuses with nothing sent.
- **Presses before the session's listener started** are covered by the HID system's idle time. It also counts input other programs post, so it can only make a session's first takeover wait (at most 5 s), never admit one early.

When the person is still at it as the call's time runs out, the call fails without sending anything:

> UserIntervened: the user is still typing, clicking or holding input (last activity 0.4 s ago), so no takeover started; nothing was sent; try again once they pause

Limits, stated in `docs/computer-use.md`:
- Someone who starts typing again once the takeover is running still puts their first key into the target before the existing stop ends the call, as on `main`.
- With Input Monitoring off nothing waits, as before. The HID system's idle time needs no permission but cannot stand in: it counts OMP's own takeover keys and clicks (0.12 s after a takeover `type`) and keys any program posts (0.05 s), so OMP's own takeovers would hold each other back.
- While Secure Event Input is on (the person typing a password), macOS hides their keys from the listener, so the takeover does not wait for them; a held button or modifier without new presses does not count.
- `raise()`, `perform("AXRaise")` and `apps.open` with `activate` bring an app forward without this wait.

Review first: `control/intervention.rs` (`UserInputs::pause_before_takeover`, `admit_takeover`, `takeover_admitted`, `start_takeover`), then `control/macos.rs` (`observed`, `UserInputMonitor::start`) and the `skylight::with_foreground` call.

## Testing

On a macOS 26.5 VM, a kit test app per surface and a simulated person typing into their own front window through the VM's VNC keyboard (macOS sees it as hardware), 10 calls per cell, `main` (`fe194ec2f12`) against this branch. The person's text is scored from their own window and every key the target app logged; the agent's text from the target's state.

Unchanged where nobody types: background `el.type`, click then `win.type`, and `cmd+k` on AppKit and Chrome, 10 of 10 on both builds. The HandBack takeover cells of #19208 (one and two windows, Chrome, a click on the person's other window or a third app, a click on the target, a background click that steals the front), 10 each with 6 s of quiet before the call: identical outcomes on both builds, call times within 11 ms.

The tool's guidance for `UserIntervened` now names the admission refusal. Haiku 5.5 and GPT-6.1 Sol, 4 one-turn samples each with `main`'s and this branch's guidance after that refusal: 16 of 16 re-read the window before anything else, none typed again.

`cargo test -p pi-natives --lib -- desktop::control::intervention desktop::control::macos`: `a_takeover_waits_until_the_user_stops_typing_in_their_own_app`, `a_takeover_the_user_keeps_typing_through_fails_without_sending`, `the_hid_idle_time_stands_in_for_presses_before_the_tap_started`, `a_takeover_admitted_before_the_lease_stops_at_a_press_since` and `only_the_users_own_devices_hold_a_takeover_back` fail with the rule taken out (presses into other apps not timed, the HID seed dropped, posted keys counted) and pass with it. Full `pi-natives` lib tests pass on macOS (999) and the desktop tests on Linux (308).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
