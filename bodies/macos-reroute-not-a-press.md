## What

When OMP changed a pop-up button in an app behind mine while I kept typing in my own window, it sometimes stopped with "the user pressed a key or clicked" in that app, though every key I typed stayed in my window, so a key OMP itself moves back to my app now counts as typed there, not in the agent's target.

With a simulated person typing in their own front window, a background `setValue` on an AppKit pop-up button stopped falsely in 3 of 40 calls on `main` and in 0 of 40 with this PR; the option was applied in every other call, and the person lost no key on either build.

| Person typing in their own window, AppKit pop-up `setValue("Two")`, window covered or merely behind (10 calls each) | `main` | this PR |
|---|---|---|
| 6 s of quiet before each call, 20 calls | 1 stopped ("the user pressed a key or clicked in fx-appkit") | 0 stopped |
| calls back to back, 20 calls | 2 stopped | 0 stopped |
| option applied / person's keys lost | 37 of 40 / 0 | 40 of 40 / 0 |
| call time (medians) | 585-590 ms | 588-597 ms |
| nobody typing: background `el.type` / `el.press("cmd+k")` into an AppKit field, 20 interleaved calls each (medians) | 634 / 784 ms | 638 / 785 ms |

## Why

Pressing the pop-up opens its menu, which takes the keyboard, so macOS addresses the person's next keys to the app behind theirs. OMP already moves such keys back to the person's app (`macos/key_reroute.rs`), but the listener that watches for the person stepping into the target sees each key first, where macOS still names the target, and counted it there: the call stopped with `UserIntervened`, and the next call aimed at that app waited 5 s and refused ("the user was using …").

- **One rule, shared with the tap that moves keys.** The listener asks the reroute registry where a key addressed to the target lands and gets the target tap's own answer: a posted key stays, a repeat follows its press, and any other press goes to the person's app while the latest action sees the target holding the keyboard uninvited, no mouse button changed since, and secure entry is off.
- **Real interventions still stop the call.** Clicks are never moved; once the person clicks the target its keys count there again; typing into a target that is their front app was never moved.

Limit: the listener decides just before the target's tap does, so a change of keyboard holder in that instant can count one key on the wrong side.

Review first: `macos/key_reroute.rs` (`Registry::landing`, `Landing::resolve`, `rerouted_to`, `key_of`), then `control/macos.rs` (`input_target`).

## Testing

On a macOS 26.5 VM, `main` (`fe194ec2f12`) against this change, builds interleaved per call; the simulated person types through the VM's VNC keyboard (macOS sees hardware), scored from their own window and every key the target app logged.

| 10 calls each | `main` | this PR |
|---|---|---|
{intervention}
| Person typing in their own window, `el.type` into a Safari page field, with the macOS takeover pause and background typing into WebKit fields also applied (both queued) | 4 stopped with `UserIntervened` | 0 stopped, all typed in the background |
| Same into a WKWebView field | 0 stopped | 0 stopped |

Eight mutations of the rule each fail one of `desktop::macos::key_reroute::tests::the_monitor_reads_a_press_landing_where_the_targets_tap_sends_it` (the registry's answer equals where the target's tap sends the same key in each state), `the_monitor_reads_a_repeat_landing_where_its_press_went`, and `desktop::control::macos::tests::a_key_the_focus_guard_moves_back_lands_in_the_users_app` (the listener's wiring). Full `pi-natives` lib tests pass on macOS (997) and the desktop tests on Linux (308).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
