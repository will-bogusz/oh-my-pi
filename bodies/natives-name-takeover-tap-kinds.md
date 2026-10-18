## What

I made the two macOS takeover taps decide what an event type they listen to means even when nobody wrote an arm for it, so adding a type later can't quietly turn the user's input into nothing.

- `user_input` (the takeover Escape monitor) ended in `_ => None`. A type the tap listens to now falls through to `Choice` unless it is outside `MONITORED_TYPES`, so the hand-back stands down instead of taking the front back.
- `input_target` (the user-input monitor) names key presses and the three mouse presses, and sends any other type to the front process instead of dropping it. Clicks without a target are still dropped on purpose, as the doc says.

Nothing changes for today's types: each one already has its own arm.

## Why

Both matches were on raw `u32` kinds and failed open. In `user_input`, a type added to `MONITORED_TYPES` without an arm would still count in `SEEN`, so the monitor would look caught up while the event read as no input, and the hand-back would take the front back over a window the user had just picked. In `input_target`, a type added to the tap mask without a target pid would never be recorded, so input into a window the agent last read would not make it read again. Failing toward counting costs one extra re-read; failing toward dropping lets the agent act on what the user changed.

## Testing

On a Mac (bench-mac), `cargo test -p pi-natives --lib` and `cargo clippy -p pi-natives --all-targets -- -D warnings`: RESULTS.
On a Mac (bench-mac), `cargo test -p pi-natives --lib`: 807 passed, 1 failed, the failing one being `skylight::tests::a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front`, which fails on `main` too. `CI=1 bun run check:rs` (fmt and clippy) exits 0.
- `the_monitor_classifies_every_event_it_counts`: for every kind 0..64, the tap's mask, `seen_index` and `user_input` agree, so a type added to `MONITORED_TYPES` without a decision fails here.
- `the_user_input_tap_listens_only_to_types_with_a_target_rule` pins the user-input mask to the four types `input_target` names; `input_target`'s test gains the other-button press and an unlisted type going to the front process.

The fallback arms can't be reached with today's constants, so no test fails with them reverted; the two tables above are what fail when a type is added.

No CHANGELOG entry: nothing a user sees changes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
