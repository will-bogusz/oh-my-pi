## What

I wanted a cancelled or timed-out `press()`, `perform()` or `raise()` on macOS to stop sending, as the rest of the computer tool does.

Before acting, the element's action names are read (`AXUIElementCopyActionNames`), which waits up to the app's AX timeout when the app is slow to answer. A run cancelled during that read (the host interrupt, a `computer.run` timeout) still went on to send the press or raise afterwards: the press path checked only whether the user had used the app, and the raise path checked nothing. A timed-out call could therefore press a button, or pull a window over the user's app, after the call had already returned.

Now `press_into_view` checks cancellation before the optional scroll and the press, and the AXRaise branch checks it before the raise (`raise_unless_cancelled`). The raise is deliberately not gated on user input: it sends the app no input, and takeover's restoration raise, which runs inside `control::cleanup` after the user may have typed, must still go out. Inside cleanup `control::check()` passes, so restoration is unchanged.

## Why

A `computer.run` that timed out reported the timeout, and then the window it was raising came up anyway, in front of whatever the user had moved on to.

## Testing

An AppKit fixture that answers `AXActionNames` 1.8 s late, TextEdit in front, macOS 26.5.2 VM, addon swapped into `@oh-my-pi/pi-coding-agent`: `computer.run(..., { timeout: 1 })` around `w.raise()` timed out every time; on main the window was raised afterwards anyway in 5/5 trials, on this branch in 0/30. Without the timeout the raise lands on both. `a_run_cancelled_before_the_send_sends_no_action` passes here; its press assertion fails on main (the press goes out with the token cancelled). It also shows the raise is withheld when cancelled and still sent inside cleanup. `no_action_is_sent_once_the_user_used_the_app` now also shows a raise still goes out after the user used the app.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
