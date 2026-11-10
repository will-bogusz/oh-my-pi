## What

I run several omp sessions with `computer` on one Mac, and a click in one failed with `InputBusy` whenever another was mid-call, so I made input wait a few seconds for the other session's call to finish instead.

A click sent while another omp session's `apps.open` was waiting for its window failed in 68 ms on `main`; with this PR it waits for that call (up to 5 s) and then goes through.

> **Computer context.** Every call that sends input, raises a window, opens an app or reads a menu takes one input lock shared by all of the user's omp processes. A call that finds it taken fails `InputBusy` and sends nothing.

- `InputLease::acquire` (`crates/pi-natives/src/desktop/control.rs`) retries every 50 ms while another session holds the lock, for up to 5 s, ending 250 ms before the run's deadline. Cancelling the call ends the wait.
- The run deadline now reaches native code on Windows too (it was macOS and Linux only).
- Unchanged: within one session (a second call under held control, its lingering release helper) input still fails at once; a lock held past the wait fails with the same `InputBusy`; `computer.control.acquire` does not wait.

## Why

Session A's `computer.apps.open("…/index.html")` returned after 3.6 s with `window: null`; one second in, session B's `win.click(…, {takeover: true})` failed `InputBusy`, and the agent slept 3 s and retried. `apps.open` holds the lock through the launch and up to 3 s waiting for the first window (`FIRST_WINDOW_WAIT`). Each agent session, subagents included, has its own native session, so this grows with parallel work.

5 s covers an `apps.open` that started just before; a click holds the lock for far less. A longer holder (held control, long typing) still makes the other fail, 5 s later.

Rejected: releasing the lock while `apps.open` only polls the window list. It fixes only `apps.open`; two sessions' clicks and typing would still collide.

A takeover call that waits arms its physical-Escape stop during the wait, since it takes the user's pointer and keys once the lock frees.

## Testing

- `input_waits_for_another_hosts_control_up_to_its_bound` holds the lock from a second handle, as another omp process does, on an injected clock: released during the second poll, input gets it after 100 ms; held, `InputBusy` after exactly 5 s; with the run ending in 2 s, at 1.75 s.
- `cancelling_input_that_waits_for_control_ends_the_wait`: a cancel during the wait returns `Cancelled` after one poll.
- `physical_escape_stops_takeover_input_waiting_for_control`: an Escape during a takeover call's first wait returns `Cancelled` and counts one Escape stop.
- Negative control: with the wait set to zero (`main`'s behaviour), the first two new tests fail; without the Escape stop during the wait, the third ends `InputBusy` after 5 s.
- `cargo test -p pi-natives --lib desktop::` on macOS (547 passed) and `desktop::control::` on Linux; clippy and rustfmt on macOS, Linux and Windows. Not run: tests on Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
