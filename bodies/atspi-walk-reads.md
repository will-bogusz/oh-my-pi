## What

I made Linux accessibility reads send an element's independent questions together instead of waiting for every answer before asking the next question. On current main, interleaved `find()` measurements across Kate, Dolphin and both LibreOffice backends take 53-62% less time, with non-overlapping observed ranges.

The first round reads name, description, role, state, interfaces and `ChildCount`. Only after it answers does the second round ask for children, text, bounds and actions concurrently, skipping interfaces the element does not implement. If interfaces cannot be read, it still tries each. `childCount` remains the app's count rather than the length of its returned children.

Both rounds stay inside main's cancellation and request deadline. Frame refresh and hit-test budgets are unchanged; the existing cache-free text helper is reused.

## Why

Large `find()` and `ax()` walks pay for many serial bus round trips. Batching independent requests removes serialization inside AT-SPI without introducing a shared cross-platform batched walker.

An element that does not list `Component` is not asked for bounds: input fails with `NO_CLICKABLE_BOUNDS` rather than using an empty rectangle at the screen origin.

## Testing

Current main `9f728bd56e` versus this head `35a9e15702d`, same goliath Ubuntu 22.04 X11 guest and the same running app/window for each pair. Eight measured pairs per app alternate main/head order, after one excluded warmup pair. Times are medians with the full observed min-max range; the ranges are smaller than the gain on every app.

| App | Elements | Main seconds, median [range] | This PR seconds, median [range] | Bus calls/element, main → PR |
|---|---|---|---|---|
| Kate 21.12.3 | 863 | 1.616 [1.542-1.717] | 0.659 [0.640-0.673] | 10.660 → 9.632 |
| Dolphin 21.12.3 | 504 | 0.979 [0.920-0.998] | 0.370 [0.360-0.389] | 10.522 → 9.187 |
| LibreOffice 7.3.7 Writer, GTK3 | 1,954 | 3.319 [3.262-3.383] | 1.570 [1.509-1.669] | 10.712 → 10.345 |
| LibreOffice 7.3.7 Writer, KF5 | 2,057 | 4.082 [4.034-4.188] | 1.932 [1.851-2.000] | 11.877 → 11.549 |

The real AT-SPI `ax::query` (`find`) path runs with limit 5,000 in identical Rust test-profile builds. Fixtures are a 300-line text file, a directory of 150 files and an identical 180-paragraph document for each Writer backend. `dbus-monitor --profile` counts method calls from the reader's unique bus sender during each query, divided by returned elements. Element and bus-call counts are stable across all measured pairs. No model runs.

Re-run on current main on Linux: `cargo test -p pi-natives --lib desktop::linux` (100 passed; 30 unrelated display tests ignored), `cargo test -p pi-natives --lib desktop::ax` (45 passed), and Linux `rust-check` passed.

`an_element_is_read_in_two_rounds_and_only_on_its_interfaces` holds peer-to-peer D-Bus replies until every expected call arrives. It requires ChildCount before GetChildren, checks skipped interfaces and the unknown-interface fallback. Existing unanswered-app and cancellation tests retain the request boundary.

Not run: full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
