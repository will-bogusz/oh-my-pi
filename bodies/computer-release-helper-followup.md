## What

I'm closing the ways the macOS release helper from #15192 could outlive its call and get in the way of the next one: Codex found two, and our test runs on a loaded Mac showed a third.

- **Held control, slow helper.** With `computer.control.acquire()` held, ownership stays with omp between calls, so a helper that the last call stopped waiting for (it waits up to 500 ms) did not keep the next call out. The next call could press while the old helper still posted its releases. Input now refuses with `InputBusy` until that helper has exited.
- **A helper slower than the wait.** A helper still starting on a loaded machine outlasted the 500 ms wait and kept its share of the ownership lock, so the next call failed with `InputBusy`. With nothing left to release, the call now stops it and moves on.
- **Missed events.** macOS turns off an event tap that falls behind; the helper turned it back on but lost the key and button changes in between, so its idea of what you hold could be stale. If omp then died, a released key could carry a modifier you had let go of, or miss one you had pressed. On re-enable the helper now reads the keyboard and mouse state back.

## Why

- **Refuse rather than wait, under held control.** Each call already waits for its own helper; one still running after that has releases to post, and refusing with the existing `InputBusy` is what a second process sees.
- **Stop only a helper with nothing open.** One with presses still open (omp panicked mid-press) keeps running until its releases are out; one with none has nothing to post. It is asked with `SIGTERM`, so it closes its event tap first.
- **What is down after the gap is yours, unless a press of this call holds it.** The HID state cannot tell your keys from this call's. Keys that went down in the gap count as yours, marked unsure; an unsure key this call itself pressed is released, as before, so it is never left down. A release some process posts settles an unsure key as that process's. Limit: you pressing the very key this call holds, during the gap, still gets released.

Reading order: `release.rs` (`UserHolds::resync`, `for_plan`) → `release_helper.rs` (`observed`) → `release_guard.rs` (`end`, `stop`) → `control.rs` (`InputLease::acquire`).

No CHANGELOG line: all three fix behaviour of #15192, which no release has shipped.

## Testing

- `control::tests::held_control_refuses_input_until_an_earlier_operations_helper_is_reaped`: held control, a helper's share still out → `InputBusy`; once it is reaped → input proceeds.
- `release_guard::tests::a_request_with_nothing_open_stops_a_helper_that_outlasts_the_wait`: a helper that never reads its stream is stopped and reaped before the call returns.
- `release::tests::holds_read_back_after_the_tap_missed_events_are_the_users_unless_a_press_holds_them`: after a gap, your right Shift keeps this call's Shift down, and A's release carries Shift and not the Option you let go of.

Each fails with its fix reverted. `cargo test -p pi-natives --lib`, `CI=1 bun check` and the computer tool tests pass on macOS 26 (Apple silicon). Not run: a real tap timeout, which needs a stalled run loop.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
