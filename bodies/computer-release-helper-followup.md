## What

I'm closing two gaps Codex found in the macOS release helper from #15192, where a release meant for a dead or finished call could cut short a key or button that is held now.

- **Held control, slow helper.** With `computer.control.acquire()` held, ownership stays with omp between calls, so a helper that the last call stopped waiting for (it waits up to 500 ms) did not keep the next call out. The next call could press while the old helper still posted its releases. Input now refuses with `InputBusy` until that helper has exited.
- **Missed events.** macOS turns off an event tap that falls behind; the helper turned it back on but lost the key and button changes in between, so its idea of what you hold could be stale. If omp then died, a released key could carry a modifier you had let go of, or miss one you had pressed. On re-enable the helper now reads the keyboard and mouse state back.

## Why

- **Refuse rather than wait.** Each call already waits for its own helper; a helper still running after that is stuck, and refusing with the existing `InputBusy` is what a second process would see.
- **What is down after the gap is yours, unless a press of this call holds it.** The HID state cannot tell your keys from this call's synthetic ones. Keys that went down in the gap count as yours, marked unsure; an unsure key this call itself pressed is released, as before, so it is never left down. A release some process posts settles an unsure key as that process's. Limit: you pressing the very key this call holds, during the gap, still gets released.

Reading order: `release.rs` (`UserHolds::resync`, `for_plan`) → `release_helper.rs` (`observed`) → `control.rs` (`InputLease::acquire`).

No CHANGELOG line: both fix behaviour of #15192, which no release has shipped.

## Testing

- `desktop::control::tests::held_control_refuses_input_until_an_earlier_operations_helper_is_reaped`: held control, a helper share still out → `InputBusy`; after it is reaped → input proceeds.
- `release::tests::holds_read_back_after_the_tap_missed_events_are_the_users_unless_a_press_holds_them`: after a gap, your right Shift keeps this call's Shift down, and A's release carries Shift and not the Option you let go of.

Both fail with their fix reverted. `cargo test -p pi-natives --lib` and `CI=1 bun check` pass on macOS 26 (Apple silicon). Not run: a real tap timeout, which needs a stalled run loop.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
