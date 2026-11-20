## What

I made Windows button actions keep their promise that an unsent timeout will not click something later.

Menu-less AX `press()` and `perform()` now include native buttons in the dispatch fence: if the caller stops waiting first, no click is sent; if dispatch began first, a missing reply is `AxUnconfirmed`, not an unsent `Timeout`.

Coordinate clicks, chords, menu paths, value writes and other platforms are outside this change.

## Why

Classic Windows and WinForms buttons use `BM_CLICK` instead of UI Automation's activating Invoke path. That route checked cancellation but never crossed the reply fence, so it could click after the caller returned a timeout promising nothing would happen later.

The mark belongs immediately before the button message, not at action lookup: reads before dispatch can still be abandoned safely. A zero message budget keeps the existing no-click refusal without marking dispatch. Review `click_button` first; future native-button delivery routes must preserve this same boundary.

## Testing

The existing native-button fixture ends the reply wait during the check-state read and at entry to the click handler. It asserts the unsent side receives no click and the sent side has already crossed the fence, without timers or sleeps. The existing session fence tests cover the caller's `Timeout` versus `AxUnconfirmed` mapping.

At final head `006f5d37670`, the same native fixture passes with the fix and fails when only the dispatch mark is removed:

| Guest | Fix | Mark removed |
|---|---|---|
| Windows 10 22H2 | 1 passed | 1 failed: a click arrived after abandonment |
| Windows 11 | 1 passed | 1 failed: a click arrived after abandonment |

<details>
<summary>Standalone test executable provenance</summary>

Both guests read back these SHA256 values from the executable they ran; no addon was installed:

- Fix: `4d35c9b286488cb761d72f62af08f4fc64f1971d3f8dc29ab90c604f288c7714`
- Mark removed: `709782c3acb0cabad494c7dc5a1a7a6bdd427d7044f8d7711feb6684ca50e2f6`

</details>

Reproduce the native row with `cargo test -p omp-natives --lib button_clicks_land_before_returning_and_unchanged_check_boxes_fail`; remove only `control::dispatching()?` in `click_button` for the negative control. Session fence checks use the `a_dispatched_provider`, `an_abandoned_provider` and `dispatch_fence_tracks_each_request_independently` test filters.

At `006f5d37670`, Linux fence checks pass (four tests). `rust-check` clippy and rustfmt pass on Linux, macOS and Windows for the final Rust diff. Full `bun check` was not run; this is a Rust-only change.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
