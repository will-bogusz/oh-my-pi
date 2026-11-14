## What

When OMP needed a takeover on my Mac while I was still typing in another app, it pulled its target in front of me and my next keystrokes went into the agent's field, so a macOS takeover now waits until I've stopped typing for 5 seconds, the same rule X11 already has.

With a simulated person typing in their own front window, 89 of their keystrokes landed in the agent's field across 30 `el.type` calls on `main`; with this PR none did, and none went missing.

| Person typing in their own window, 10 calls each | `main` | this PR |
|---|---|---|
| WKWebView page field, `el.type` (falls back to a takeover) | 22 of their keys in the agent's field (5 calls), 5 refused | 0; waits for their pause (7.1 s), then the takeover fails `InputFailed` as it does on `main` with nobody typing |
| Safari page field, `el.type` | 22 keys (5 calls), 5 refused | 0; waits, then 9 fail as above, 1 typed |
| Chrome page, first `el.type` after launch | 45 keys (10 of 10 calls) | 0; 10 of 10 typed after their pause (7.1 s) |
| Takeover `type` while they pause 6 s mid-sentence | 10 of 10 typed (0.54 s; it ran while they had paused) | 10 of 10 typed once 5 s were quiet (4.5 s) |
| Call given 8 s while they type for 10 s (3 calls) | 4 to 5 of their keys missing from their window per call | refused at 7.76 s, 0.25 s before its timeout, nothing sent, 0 lost |
| Call with the default 120 s while they type for 49 s (2 calls) | | waited it out, typed once they stopped, 0 lost |

| Cost | `main` | this PR |
|---|---|---|
| Takeover within 5 s of their last key or click | no wait | the rest of those 5 s: 4.5 s (pause cell), 3.3 s (listener started mid-pause), 7.1 s (web cells, their typing runs about 2 s past the call) |
| Takeover with nobody typing, right after a background click and key or another takeover (medians, AppKit and Chrome, 10 each) | 529–545 ms | 521–530 ms |
| Background `el.type` / `el.press("cmd+k")` into AppKit, 20 interleaved calls each (medians, spread 10–15 ms) | 640.5 / 786.5 ms | 642.5 / 789.0 ms |

> UserIntervened: the user is still typing, clicking or holding input (last activity 0.1 s ago), so no takeover started; nothing was sent; try again once they pause

## Why

A takeover brings its target in front of the user's keyboard, so every key they type from then on lands there. On macOS it waited only for input into the target app, so the background fallback's rerun (and any `takeover: true` call) brought the target forward mid-sentence. #18784 gave X11 a pause it said macOS had; macOS's covered only the target app, so this gives macOS X11's rule.

- **One rule for both platforms:** one shared constant and message (`control::USER_QUIET`, `control::still_active_refusal`); X11 is unchanged.
- **Only the person's own keyboard and pointer count** (CGEvent source pid 0). Keys another program posts do not hold a takeover back, as they do not stop a hand-back today; counting them would let any background typer block every takeover.
- **The wait comes before the input lease**, in the worker's admission as on X11, and is rechecked under the lease and as the takeover starts; a press in between refuses with nothing sent.
- **Presses before the listener started** count through the HID system's idle time, which also counts posted input, so it can only make a session's first takeover wait, never admit one early.

Limits, in `docs/computer-use.md`: a key typed once the takeover runs still lands before the existing stop, as on `main`; with Input Monitoring off nothing waits, and HID idle time cannot stand in, since it counts OMP's own takeover input (0.12 s after a `type`) and posted keys (0.05 s); Secure Event Input hides the person's keys; `raise()`, `perform("AXRaise")` and `apps.open` with `activate` do not wait.

Review first: `control/intervention.rs` (`UserInputs::pause_before_takeover`, `admit_takeover`, `takeover_admitted`, `start_takeover`), then `control/macos.rs` (`observed`, `UserInputMonitor::start`) and the `skylight::with_foreground` call.

## Testing

On a macOS 26.5 VM, a kit test app per surface and a simulated person typing into their own front window through the VM's VNC keyboard (macOS sees it as hardware), `main` (`fe194ec2f12`) against this branch, scoring the person's text from their own window and every key the target logged. With nobody typing, outcomes match `main`, the #19208 hand-back cells included.

<details><summary>Cells, unit tests and the guidance sample</summary>

Unchanged where nobody types: background `el.type`, click then `win.type`, and `cmd+k` on AppKit and Chrome, 10 of 10 on both builds. With the person typing, background `el.type` and click then `win.type` (every surface in the table's runs) and `cmd+k` (AppKit and Chrome, 775 and 797 ms against 769 and 789 ms) were 10 of 10 on both builds, none stopped falsely. The HandBack takeover cells of #19208 (one and two windows, Chrome, a click on the person's other window or a third app, a click on the target, a background click that steals the front), 10 each with 6 s of quiet before the call: identical outcomes on both builds, call times within 11 ms.

With #19208 merged in, against #19208 alone, 20 tries each, the person switching while the takeover runs: the end state was the same on both trees in every try (their other window key and main, 20 of 20; the third app they picked in front, 20 of 20; and where their click races the hand-back, the same 17 and 3 split on both). In 1 of 20 tries of each switch cell, the session's first takeover waited 3.3 s for presses from before its listener started, so the person's switch came before it began; it then typed and handed back to their choice instead of failing `InputFailed`.

The tool's guidance for `UserIntervened` now names the admission refusal. Haiku 5.5 and GPT-6.1 Sol, 4 one-turn samples each with `main`'s and this branch's guidance after that refusal: 16 of 16 re-read the window before anything else, none typed again.

`cargo test -p pi-natives --lib -- desktop::control::intervention desktop::control::macos`: `a_takeover_waits_until_the_user_stops_typing_in_their_own_app`, `a_takeover_the_user_keeps_typing_through_fails_without_sending`, `the_hid_idle_time_stands_in_for_presses_before_the_tap_started`, `a_takeover_admitted_before_the_lease_stops_at_a_press_since` and `only_the_users_own_devices_hold_a_takeover_back` fail with the rule taken out (presses into other apps not timed, the HID seed dropped, posted keys counted) and pass with it. Full `pi-natives` lib tests pass on macOS (999) and the desktop tests on Linux (308).

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
