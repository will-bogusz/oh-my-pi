## What

I found that a click in the instant the macOS focus guard's input tap starts could be counted twice: first as in my own app, then again where it went, so a target that click picked could be sent back. The click record now reads the HID counters before the tap is enabled.

## Why

The record behind the focus guard (#16553) snapshots `WindowServer`'s button counters after the session's tap is enabled. A press landing in between is in the snapshot and then delivered by the tap as one more than the counters show, so readings place it in my app until the tap delivers it. Reading the counters first leaves every later press to the tap, or to the 50 ms give-up, which counts it as mine and owed, like a press a remapper swallowed. Codex found this on #16553 (`Listener::listening` in `desktop/control/intervention.rs`).

## Testing

- `the_click_record_starts_before_the_tap_that_feeds_it` fails with #16553's order (4350f38c5f) and passes here.
- `cargo test -p pi-natives --lib -- desktop::`: 570 pass. `rust-check` passes on macOS and Linux.
