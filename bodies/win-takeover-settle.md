## What

When a Windows takeover targeted an app that was busy, the call failed but the app jumped in front of me a moment later and took my keyboard; now OMP takes that late activation back, gives my window the foreground again, and the error says what happened.

| Windows, takeover of a busy app | `main` | this PR |
|---|---|---|
| Windows accepts the activation, the app is not in front within 500 ms | the call fails as "Windows refused to activate", and the app comes to the front once it reads its messages, after the call returned: the user's next keys go to it | the user's window gets the foreground back, the app is given up to 2 s (within the call's deadline) to read the activation, and if it came forward anyway with no user input since, the foreground is handed back again; the error says which happened, or that the hand-back is unconfirmed |
| `raise()` of such an app | "Windows refused to raise window (foreground lock)" | says Windows accepted the raise and the window may come forward later |
| Refused outright, or activated in time | unchanged | unchanged |

> **Windows context.** `SetForegroundWindow` on another app's window returns at once, but the window becomes active only when that app's thread next reads its messages; a busy app does that later. Windows can also refuse the request (it returns zero); OMP still polls 500 ms then, as on `main`.

## Why

- **Not overriding the user:** the take-back hands back only when the target, or a window it owns, is seen in front and `GetLastInputInfo` shows no input since the call started (a target in front could be the user's own choice); a window the user switched to is left alone, and a foreground reported as none (a switch in progress) is treated as unknown, not as the target's.
- **Cancellation:** an Escape or cancel during the activation wait takes the same path, because the activation may still be pending; the take-back's waits are bounded by the call's deadline.
- **Rejected:** probing `AllowSetForegroundWindow` for the process's right to activate before trying. On our Windows 11 guest a build with that probe refused 60 of 60 calls, where `main` ran 30 of the same 60.

Read `ForegroundGuard::activate` and `take_back_owed_activation` in `win32/input.rs`, then `window::activate` (`Activation`).

## Testing

`a_takeover_whose_target_comes_forward_too_late_leaves_the_users_window_in_front` fails on `main` and passes here, Windows 11, interleaved twice each (built at a0a48678174, the head adds rustfmt; `main` = the same test binary with `win32/input.rs` and `win32/window.rs` at `main`): the target's thread stalls without dispatching its activation until the take-back's `WM_NULL` fence or the test's release after the call; on `main` the user's window was not in front after the target drained its queue (2 of 2), here it was, with the accepted-activation error and both windows' text unchanged (2 of 2). The shared test window host now grants the test process the foreground after it puts the user's window in front (a checked `AllowSetForegroundWindow` round trip); without it Windows refused the test's activation in every windowed test on our guests, `main`'s own included.

A/B, `main` v19.0.1 against this branch's addon (built at 9ec50053c64; later commits change only the recovery path and the test fixture), WPF target with the user's window beside it, interleaved, so the fix refuses nothing that worked before: on Windows 11, with OMP restarted before each call, takeovers ran 37 of 40 on `main` and 36 of 40 here, the rest refused outright on both. On Windows 10 (target clicked once while in front first, the procedure in which that guest lets OMP take the foreground) 40 of 40 ran on each.
