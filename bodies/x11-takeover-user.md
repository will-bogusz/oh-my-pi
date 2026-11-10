## What

I made X11 takeover wait for the user to stop typing and stop at their first key, because it otherwise activates the agent's window while they type and their keys land there.

On GNOME X11, a user typing 70 characters while the agent clicked a covered window lost 28 of them to the agent's window on main, and none to it with this PR.

A raw click on a covered X11 window is refused in the background, and `computer.backgroundFallback: takeover` (the default) reruns it in takeover: the target is activated and XTEST drives the user's own keyboard and pointer until focus returns. Nothing watched the user. Now, for a window or element takeover:

| | main | this PR |
|---|---|---|
| User typing when the takeover is due | starts at once; their keys go to the target until focus returns | waits until they have pressed nothing for 5 s, never past the run's timeout; still typing then: `UserIntervened`, nothing sent |
| User presses a key or button during it | goes to the target; the takeover carries on | stops with `UserIntervened` before its next key, move or button; focus and pointer handed back as usual |
| User idle | takeover | same |

## Why

macOS already waits for the user to pause and stops at their first key (`UserIntervened`); X11 did neither, though the docs said its rerun "yields to user activity".

Decisions:
- Presses are XI2 raw events, which name the device each came from (OMP's MPX devices never count). The listener asks for XI 2.2 (2.0 clients get nothing during another client's grab) and starts with the session's first screenshot or takeover.
- XTEST presses beyond the ones the session sent count as the user's: x11vnc and xdotool type through XTEST.
- The wait runs under the input lease, so physical Escape stops it; another session's input meanwhile gets `InputBusy` (#18746 would make it wait).
- It waits rather than refusing at once, as on macOS: a refusal costs a turn.
- Unchanged: `refuse` already holds on every X11 path; focus, pointer and stacking are already restored; desktop and display input, `raise()` and activating `apps.open` are not gated; holds are not checked mid-hold (nor on macOS); the prompt still says "`UserIntervened` (macOS)".

**Question for the maintainer: should an occluded target on X11 refuse by default, as Cua does (`target_occluded`)?** With this PR, `takeover` keeps the user's keys but still takes their focus and pointer once they pause, and the click waits for that pause (10.8 s median below). `refuse` touches nothing and answers in 7 ms, but the agent needs another route (AX, `el.press()`). This PR keeps `takeover`.

## Testing

- Live, KVM guest (Ubuntu 24.04.5, Xorg 21.1.12, mutter 46.2): screenshot, pixel click on a covered GTK entry and `win.type`, while QEMU types 70 characters at 12/s into the user's window; n=10 per arm, no-agent controls lost 0, goliath 21–23 GiB available at each arm's start:

  | Arm | user chars lost | user's focus taken | pointer moved | agent call wall, median |
  |---|---|---|---|---|
  | main, `takeover` | 28 (10/10 trials) | 10/10 | 10/10 | 0.70 s |
  | this PR, `takeover` | 2, all in trial 0, none into the target¹ | 10/10, after the user paused | 10/10, after | 10.8 s |
  | this PR, user types 283 characters (23.6 s) without a pause | 0 | 10/10, after the user paused | 10/10, after | 28.6 s |
  | main, `refuse` | 3, all in trial 0, after the click had refused¹ | 1/10, trial 0 | 0 | click refused in 7 ms |

  ¹ The first trial after the probe restart, while the fixture's windows re-mapped. Every trial ended with the user's window on top and active.
- `a_takeover_refuses_a_typing_user_but_not_its_own_keys` (Xvfb, `--include-ignored`): the takeover's key reaches the target and does not count, another client's XTEST key does, and the next takeover fails `UserIntervened` with nothing delivered; it fails with the admission removed. Four unit tests cover the wait, the stop and the device accounting.
- `scripts/rust-check` on Linux and macOS.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
