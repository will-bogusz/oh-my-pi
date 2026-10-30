## What

On iPhone Mirroring, one takeover tap left every later background tap going nowhere until something pressed a key in the window, so before each background tap or scroll there I press Shift through the background key route first.

After one takeover tap, background taps reached the phone in 0 of 8 tries on `main` and 8 of 8 with this PR.

**Cost:** a background tap call on iPhone Mirroring takes about 1 s with the Shift press (968–1,032 ms); `main`'s time per call was not measured. Other windows: unchanged.

> **iPhone Mirroring context.** The phone samples the Mac's pointer as HID reports, so omp's background route for it (`report_pointer`) posts presses addressed to the mirror window rather than events an app reads.

- `report_pointer` (`macos/input.rs`) runs `prime_reports` before a left tap or a scroll: Shift pressed and released through the background key route, inside the pointer call's own background watch, then the 100 ms pause a background shortcut takes before its reply. `primed` holds the order: target check, primer, cancel check, pointer input.
- `with_background_keyboard` is split into `keyboard_route` (the refusals before the watch) and `keyboard_in_watch` (making the window key, then delivering), so the primer reuses the keyboard route's guards without a second watch. Background keys behave as before.

## Why

On `main`, after one takeover tap every later background tap was dropped (8 of 8); waiting 10 s did not bring taps back, and a background Shift press did (3 of 3 cycles). Shift alone types nothing on the phone.

Decisions:
- The whole background key route, not a Shift posted to the process: that cheaper version brought back 0 of 3 taps.
- Before every tap or scroll rather than tracking when the window was activated: activation can come from a takeover tap, a raise or the user, and per-call priming keeps no state to go stale. Moves, drags, holds and right clicks are not primed; their behaviour after a takeover was not measured.
- Once the Shift has gone out, a refusal of the tap that follows is reported as input that may have landed, not rerun in takeover.

## Testing

- Live, iPhone 16 Pro (iOS 18.7) through iPhone Mirroring on macOS 26.1, a Safari page logging touches, two runs: a background tap, a takeover tap, then four background taps, all 8 arriving; a background tap after an explicit Shift arrived too, and the user's app stayed in front throughout. Two earlier runs, aimed at the Home Screen by mistake, stopped with `UserIntervened` after their taps had opened an app; which call raised it was not recorded.
- `iphone_mirroring_taps_are_primed_once_per_call_and_never_after_a_refusal`: a double tap is primed once before its first check-and-press; a refused check primes nothing; a failed primer keeps its error and sends no pointer input; a cancel during priming stops before any. Dropping the primer from `primed` fails it. `cargo test -p pi-natives --lib desktop` on macOS; clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
