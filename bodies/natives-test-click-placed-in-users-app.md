## What

I noticed `cargo test -p pi-natives --lib` has been failing on macOS since 89892decd0, and the fault is one line of that commit's test, not the focus guard, so I fixed the test's input and left the code alone.

`a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front` starts a lease from a reading that holds one click and then observes it with `idle`, a reading of zero clicks. The guard counts any change in the mouse-button counters as a new click, so the counters dropping from 1 to 0 looked like the user clicking to pick the target: the test expected `Restore` and got `Disarm`. The later reading now carries the same click (`clicked_at(t0)`), by then too old to place, which is what a real reading would show.

## Why

macOS's HID button counters (`CGEventSourceCounterForEventType`) count events since WindowServer started, and a lease lasts seconds, so a reading with fewer clicks than the one before cannot happen. The bug is in the test's input. The guard's `!=` comparison is fine.

CI didn't catch it because skylight's tests are `cfg(target_os = "macos")`, and CI runs Rust tests only on Linux (`rust_validate`, main only). Darwin builds are cross-compiled on Linux, and the macOS runners only smoke-test release binaries.

## Testing

On an Apple Silicon Mac, `cargo test -p pi-natives --lib`:

- `main` (58349dc80d; also 4d956dad0f and cad87a899d): 805 pass and this one test fails (`left: Disarm, right: Restore` at the `t0 + ms(60)` assertion).
- This branch: 806 passed, 0 failed. `cargo clippy -p pi-natives --all-targets --no-deps` reports the same 7 warnings as on `main` and nothing new, and `CI=1 bun check` passes.

No CHANGELOG entry: the change is test-only.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
