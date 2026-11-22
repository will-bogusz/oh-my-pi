## What

A background scroll on iPhone Mirroring moved the phone's page by one wheel event's worth whatever distance was asked, so I send it as the short paced wheel events takeover scrolls already use.

A 300 px background scroll moved a Safari page on the phone 128 px on `main` (0 → 128 → 256 over two calls) and exactly 300 px with this PR; 2,000 px moved 2,000.

- `report_scroll` (`macos/input.rs`) aims the phone once, then posts the distance as wheel events of at most 30 px, 16 ms apart, checking the target before each one; `post_background_wheel` is split out of `background_scroll` for it. A zero scroll returns before aiming. Deltas go through `quartz_scroll_deltas`, so a positive `dy` scrolls down as on every macOS path since #19165.
- Up to 200 events (`MAX_REPORT_WHEEL_EVENTS`): up to 6,000 px goes out in steps of at most 30 px per axis, about 3.3 s of paced waits (60 ms aim hold, 199 gaps of 16 ms) while other sessions' input waits on the lease. Takeover keeps its 40.

## Why

> **iPhone Mirroring context.** The phone samples the Mac's pointer as HID reports, so omp's background route for it (`report_pointer`) posts events addressed to the mirror window. It scrolls whatever is under the phone's own pointer, which a lone release first moves to the scroll point.

`main` sent the whole distance as one wheel event, and the phone moved its page by about one event's worth however large the event was. Takeover scrolls (`global_scroll`) already split into these steps for the same kind of surface.

Limit: past 6,000 px some of the 200 events carry more than 30 px per axis, unmeasured on the phone; the docs say so and suggest calls of at most 6,000 px. I stated the limit rather than adding trains: a phone screen is under 1,000 px, so 6,000 px is about seven screens, and each further 1,000 px would hold other sessions' input another 0.5 s.

Not changed: Screen Sharing and other windows, takeover scrolls, and the scroll's direction.

## Testing

- Live (2026-10-30, this change's first version), iPhone 16 Pro (iOS 18.7) through iPhone Mirroring on macOS 26.1, a Safari page logging `scrollY` until 200 ms after its last scroll event: on `main`, `dy: -300` took the page 0 → 128 → 256 over two calls and `dy: +300` back to 129. With the change: `dy: -300` moved 300 down in 5 of 5 calls and `+300` 300 up in 2 of 2 (0.80-0.86 s per call); `dy: ∓2000` moved exactly 2,000 in 7 of 7 (1.86-1.92 s). Not re-run since (no phone): #19165's later sign flip and #17756's primer are unit-tested only.
- `report_scroll_aims_once_then_posts_the_requested_distance_in_paced_chunks` (negated deltas), `report_scroll_stops_mid_train_and_keeps_long_distances_in_small_steps` (a failed check after three wheels stops at three, a cancel between wheels stops, 6,000 px is 200 steps of 30, 6,001 px is 200 summing exactly with one of 31, a zero scroll aims nothing), all with injected waits. The `desktop::macos::{ax,input}` tests pass on macOS; `rust-check` on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
