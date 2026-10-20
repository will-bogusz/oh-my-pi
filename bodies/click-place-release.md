## What

Follow-up to #16217: a quick click in my own app could still count as a click somewhere else when macOS took a while to hit-test it, so a background target that brought itself forward right after stayed in front of my app; now the press's placement carries over to its release.

During macOS background input the focus guard sends a target that activates itself back behind your app, unless you just picked it. A click in your own app picks nothing, so the guard needs to know where each click landed: the click placer finds out by an accessibility hit-test, on its own thread, that can block for 0.5 s.

| Click in your app, then the target comes forward | `main` | this PR |
|---|---|---|
| Hit-test returns before the release | sent back | sent back |
| Hit-test still blocked at the release | stays in front | sent back |

**Non-goals.** A release after the hit-test returned still gets its own hit-test, as on `main`, so a drag from your app released on the target still counts as you picking it.

## Why

The placer reads the HID button counters, runs the hit-test, and publishes the result under those counters. When the hit-test blocks past mouse-up, the switch sampler already holds the release's counters, so the press's placement matches no reading, and the release's own hit-test comes more than `CLICK_PLACE` (30 ms) after it and places it nowhere. The click stays counted as one elsewhere for `USER_SWITCH_WINDOW` (250 ms).

`ClickPlacer::place_at` now rereads the counters after a hit-test that placed the click in your app, and if only release counters moved, publishes under the new ones. A press placed elsewhere, or a second press during the hit-test, keeps `main`'s path. The sampler may then first see the placement on the release's own reading, where `main` settled the pending press without taking it back; `UserSwitchWatch::observe` now takes it back there as on a later reading (`settle_in_user_app`).

Rejected: carrying any in-app placement to the next release-only change, which would also count a drag released on the target after the hit-test as a click in your app.

## Testing

- `a_press_the_placer_places_after_its_release_still_sends_the_target_back` drives `ClickPlacer::place_at` with a fake hit-test that lets the release counters move before it returns, then feeds the readings to the guard: the target is sent back (`Restore`) whether the sampler reads the release before the placement or with it, the clicked window is kept, and a click elsewhere before the press still counts (`Disarm`). Releases after the hit-test, or after a press placed elsewhere, still get their own.
- Negative controls: publishing under the press's counters fails the first `Restore` (`Disarm`); dropping the settle on the release's reading fails the second ordering (`Disarm`).
- `cargo test -p pi-natives --lib` (929 pass) and `cargo clippy -p pi-natives --all-targets --no-deps` on an Apple Silicon Mac. The change is in the macOS-only `skylight.rs`.
- Not run: a live repro, which needs an AX hit-test to block across a real click.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
