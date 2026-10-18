## What

I noticed `cargo test -p pi-natives --lib` has been failing on macOS since #15191 merged, and the code does what that PR meant to, so I updated the stale test's expectations and left the code alone.

`iphone_mirroring_taps_and_scrolls_stop_once_the_user_brings_it_forward` came with #15193 and expected `BackgroundUnavailable` when the user brings iPhone Mirroring forward between the taps of a double tap, or during a scroll. #15191 changed what `pointer_recheck` returns on that path to `UserIntervened`, and its merge left this test behind (`left: UserIntervened, right: BackgroundUnavailable`). The test's three stop assertions now expect `UserIntervened`. The third scroll used to check only `is_err()`. It is renamed `..._stop_as_user_intervened_once_brought_forward`. Its event and no-scroll assertions are unchanged.

## Why

`UserIntervened` is the outcome #15191 meant here, so this is a stale test, not a regression:

- `pointer_recheck` (`crates/pi-natives/src/desktop/macos/input.rs:2184-2190`) returns `user_intervened` once the target came forward, with the comment "never rerun in takeover, which would take over the app they are using". An unreadable front app still returns `BackgroundUnavailable` (`:2178-2183`), and its own test is unchanged.
- #15191's CHANGELOG entry (`packages/natives/CHANGELOG.md:28`) says "on macOS a call stopped because you came to the target app throws `UserIntervened`". `docs/computer-use.md:240` and `worker.ts:499-501` say the tool never reruns it in takeover.
- `computer.backgroundFallback: takeover` reruns only `BackgroundUnavailable`. Under the old code, a user who brought iPhone Mirroring forward mid-tap would have had the call rerun in takeover, in the app they had just picked up.

#15193's entry only promises that iPhone Mirroring taps and scrolls land where aimed. It names no error code.

CI didn't catch it because these tests are `cfg(target_os = "macos")`, and CI runs Rust tests only on Linux.

## Testing

On an Apple Silicon Mac, `cargo test -p pi-natives --lib` at each merge since 58349dc80d. Other failures in these runs came from the focus-guard test fixed by #16187, plus a `release_guard` failure at 33eeebc138 only:

| commit | this test |
|---|---|
| 58349dc80d (#15562) | passes |
| 08c8af012c (#15185) | passes |
| 33eeebc138 (#15192) | passes |
| 89ae2976d7 (#15191) | fails |

This branch, on `main` 3f020bd850: `cargo test -p pi-natives --lib` 881 passed, 0 failed. `cargo check -p pi-natives --tests`, `CI=1 bun run check:rs`, `CI=1 bun check`, `bun run build:native` and the computer tool tests (`computer.test.ts`, 130 + 7 pass) exit 0.

No CHANGELOG entry: the change is test-only.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
