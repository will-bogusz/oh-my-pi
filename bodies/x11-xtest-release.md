## What

If omp got killed on X11 while the computer tool was holding Shift or the mouse button, it stayed held for the whole X session and everything I typed next came out in capitals; now a small watcher process lets go for it, the same way the macOS release helper (#15192) does.

With omp SIGKILLed while holding a key, Shift or the left button, it was still down 10 of 10 times on `main` and 0 of 10 with this change.

## Why

X11 takeover and `desktop` input press keys and buttons through `XTest`. Every call already releases what it pressed on success, error and cancellation, but only while omp lives: Xorg keeps an `XTest` key or button down after the client that pressed it is gone (`Xext/xtest.c` has no cleanup on client close). An omp killed mid-call (OOM, `kill -9`, a crashed Bun) therefore left the user's own keyboard and mouse modified until they happened to press and release the same key.

Releasing at the next omp start was rejected for the same reason #15192 rejected it on macOS: the stuck key breaks the user's input now, not when omp next runs, and there may be no next run.

A watcher process forked for each `XTest` call that can press (`crates/pi-natives/src/desktop/linux/x11/release_guard.rs`) hears of each press and confirmed release over a socket pair; when the stream ends with presses open, because omp died, it releases them on its own X connection. A call that ends normally reaps it and it sends nothing. A watcher that cannot start leaves the call to run as on `main`.

<details><summary>How the watcher works</summary>

- `ReleaseGuard::start` forks the watcher with its own X connection for `X11Input::xtest_steps` and `X11Input::pointer_xtest` (except plain moves), before the call's checks.
- `X11Input::send_xtest`, the one path every `XTest` key and button event takes, tells the watcher of each press before the request goes out and of each release once the server confirmed it, two bytes each, beside the count of the session's own presses it already keeps for the user-activity check.
- A normal end shuts the stream's write side and waits for the watcher's end to close; one that has not within 500 ms is killed.
- The watcher is a bare `fork` that only makes async-signal-safe calls until `_exit`, with all signals blocked across the fork. It closes omp's end of the stream and (through `close_range`) omp's other descriptors, leaves omp's session, and ignores SIGTERM/SIGINT/SIGHUP/SIGQUIT, so `pkill omp`, Ctrl+C or a terminal hangup still gets the releases out. Only a SIGKILL of the watcher itself, or of omp's whole cgroup, defeats it.
- Tests without an X server: `a_dead_owners_open_inputs_are_released` (omp's end closed without shutdown, with and without `close_range`, and with a SIGTERM reaching the watcher first), `a_call_that_releases_everything_sends_nothing`, `dropping_a_guard_does_not_wait_on_a_stopped_watcher`, plus the request bytes checked against x11rb's own `FakeInputRequest` serializer.

</details>

Not changed: background input and Wayland. The XInput2 MPX route presses through uinput devices, which the kernel tears down with their fd: with Shift held that way on a real Xorg and omp SIGKILLed, Shift was down while holding 30 of 30 times and still down after the kill 0 of 30 times on `main`.

## Testing

Real X server (Xvfb on goliath, Ubuntu 24.04), omp's own `X11Input` in a holder process on the desktop target, 10 tries per cell; the harness reads XI2 raw events and the server's key map and pointer state:

| Holder ended while holding (10 each) | `main` | This PR |
|---|---|---|
| SIGKILL during `holdKeys(["a"])`: `a` still down | 10 / 10 | 0 / 10 |
| SIGKILL during `holdKeys(["shift"])`: Shift still down | 10 / 10 | 0 / 10 |
| SIGKILL during `holdMouse`: button 1 still down | 10 / 10 | 0 / 10 |
| `pkill -TERM -f` matching the holder and its watcher, Shift held: still down | 10 / 10 | 0 / 10 |

Every try of those cells here sent exactly one release. A 300 ms `holdKeys` whose process then exits normally, and one whose process lives on and is SIGKILLed afterwards, leave nothing down and send one release per press on both, none after the later kill.

Unchanged from `main`, 10 of 10 on both: `XTest` text typed with Shift latched arrives unshifted (a raw `XTest` key under the same latch arrives shifted), `xtest_text_types_through_a_neutral_keyboard_state`, `xtest_keys_refuse_another_clients_keyboard_grab`, and takeover keys reaching a focused window that grabs the keyboard on itself.

- `a_killed_holder_leaves_no_xtest_key_or_button_down` (`#[ignore]`, starts its own Xvfb; `cargo test -p pi-natives --lib -- --ignored killed_holder`) passes here 10 of 10. It waits for the raw press events, fails if the holder exits first, and after the kill waits for the raw release events within 5 s.
- The Linux desktop tests with `--run-ignored all` on Xvfb: the same 10 XI2-MPX tests fail on `main` and here (they need an Xorg with uinput hot-plug); everything else passes.
- `scripts/rust-check` on Linux.

Cost: each pressing call adds an X connect, one `QueryExtension` round trip and a fork. A desktop click on Xvfb took 12.5 ms on `main` and 13.0 ms here (mean of 200 clicks, 3 interleaved blocks each, spread under 0.15 ms).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

