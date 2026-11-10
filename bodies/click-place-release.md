## What

I found that a quick click in my app could leave a background target in front when its AX hit-test finished after mouse-up; this keeps that click in my app without treating a drag onto the target as the same click.

The click placer consumes ordered press/release events with their positions. A release near an in-app press keeps its placement even when the hit-test blocks; a release away from it is placed separately. A press already placed elsewhere cannot later become an in-app click.

## Why

The focus guard must distinguish a target activating itself from the user choosing it. Sampling only the latest pointer position loses a drag's endpoints, while publishing only the press's counters loses an ordinary click whose release arrived during the hit-test.

The sampler remains independent of AX probes. Existing hold deadlines, live pick watching and hand-back stop checks remain unchanged.

## Testing

- `cargo test -p pi-natives --lib` on macOS.
- `scripts/rust-check` on macOS and Linux.
- Existing regression tests cover blocked hit-tests, both sampler orderings, release movement and presses placed elsewhere. This rebase adds no behavior test.
- No live VM check: the sole conflict was pointer acquisition versus point hit-testing after the objc2 migration, not drag posting, holding or release delivery.

## Risk

The tap can publish a press before a release already counted by HID reaches its queue. Event age is measured from callback delivery, not the original CGEvent timestamp. Closing those gaps needs release-delivery tracking and a timestamp clock mapping, respectively; neither mechanism is introduced here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
