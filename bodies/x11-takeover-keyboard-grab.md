## What

I found that on X11, while another app had a menu open or a screen locker was asking for a password, omp's takeover typing went into that app and still told the agent the text landed in the window it asked for; now it waits briefly for that grab to end and otherwise refuses with nothing sent.

With another GTK 3 app's popup menu open, takeover `type("gk")` into a focused GTK 3 entry left the entry empty and returned success 30 of 30 times on `main`, and a locker-style keyboard grab received both keys 30 of 30 times; with this change both refuse with nothing sent 30 of 30 times, after about 690 and 650 ms.

## Why

Takeover keys go out through `XTest`, which the X server delivers to whichever client holds an active keyboard grab, not to the focus window. Popup menus and screen lockers take that grab. The call activated and confirmed the target window, sent the keys, and reported success, so the agent believed text was typed that actually went into another application's menu or, worse, a password prompt.

`X11Input::check_keyboard_grab` runs inside `with_foreground` on the two takeover window paths, right before the keys. It probes with a `GrabKeyboard` of its own, waits up to 500 ms for a short grab (a window manager's switcher) to end, then fails with `InputFailed`: "a keyboard grab is active (an open menu or a screen locker of another application), so the keys would not reach the target; no input was sent". An open menu of the target's own process still gets its keys (Down, Return, Escape are meant for it), as on `main`.

<details><summary>How the probe works</summary>

- The `GrabKeyboard` targets the current focus window and its `UngrabKeyboard` goes in the same flush. `AlreadyGrabbed` or `Frozen` means another client holds the keyboard; a grab where the focus already is sends no focus events, and the user's own keys go to omp for one round trip at most.
- X does not name a grab's owner. A viewable override-redirect popup of the target's own process (`Wm::grab_popup_of`, the check background keys already use) stands for the target's own grab. That heuristic only withholds the new refusal.
- A focus window that vanishes mid-probe is retried, and past the wait the keys go out as on `main`.

</details>

Non-goals: `desktop` targets keep `main`'s behaviour (they name no window, so keys going to a grab are not a misreport); held keys and modifiers of `holdMouse`/`drag` are not probed; a target that grabs the keyboard with no popup (a VM or remote-desktop viewer) is refused as if another application held it.

## Testing

The measurements below were collected before the current main rebase; activation and admission timing has since changed.

goliath, Ubuntu 24.04, Xvfb 21.1.12 + openbox 3.6.1, GTK 3.24.41, a GTK 3 entry focused, takeover through omp's own `X11Input`, 30 trials each:

| | `main` | This PR |
|---|---|---|
| no grab: entry text, result | `gk`, Ok 30/30 | `gk`, Ok 30/30 |
| another app's GTK 3 popup menu open | entry empty, Ok 30/30 | entry empty, refused 30/30, menu got nothing |
| locker-style fullscreen keyboard grab | locker got both keys, Ok 30/30 | refused 30/30, locker got 0 keys |
| the target's own GTK 3 menu open, takeover Down then Return | item activated, Ok 30/30 | item activated, Ok 30/30 |

The refusal's time is the 500 ms wait plus activation: median 690 ms (menu) and 653 ms (locker), against 150 ms for a run with no grab on both. Not measured: a real screen locker or a real Xorg session.

- `xtest_keys_refuse_another_clients_keyboard_grab` (`#[ignore]`, starts its own Xvfb): takeover refused under another process's grab and the grabber gets nothing; desktop keys go to the grab; a grabbing popup of the target's own process gets the key; the focused window gets it once the grab ends. It fails on `main` at the refusal.
- Re-run on current main (`9f728bd56e1`): Linux `scripts/rust-check` passed; `cargo test -p pi-natives --lib desktop::linux::x11 -- --include-ignored --test-threads=1` under Xvfb passed 61 tests, including the regression, typing-user admission and named-change tests. Two MPX hotplug tests require Xorg udev/libinput; both fail identically on main under Xvfb. With those two excluded, all 61 tests pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
