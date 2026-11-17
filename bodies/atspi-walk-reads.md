## What

I made Linux accessibility reads send an element's independent questions together instead of waiting for every answer before asking the next question. Interleaved `find()` measurements against current main across Kate, Dolphin and both LibreOffice backends take 50-58% less time, with non-overlapping observed ranges.

The first round reads name, description, role, state, interfaces and `ChildCount`. Only after it answers does the second round ask for text, bounds, actions and children concurrently, skipping interfaces the element does not implement; if interfaces cannot be read, it tries each. Children are read by index as on main since #19036: at most the walk's remaining node budget, never the whole list. `childCount` stays the app's count.

Both rounds stay inside main's cancellation and request deadline. Frame refresh and hit-test budgets are unchanged.

## Why

Large `find()` and `ax()` walks pay for many serial bus round trips. Batching independent requests removes serialization inside AT-SPI without introducing a shared cross-platform batched walker.

An element that does not list `Component` is not asked for bounds: input fails with `NO_CLICKABLE_BOUNDS` rather than using an empty rectangle at the screen origin.

## Testing

Main `bf9a9fbd40e` versus this change on it (`7c83575f996`, the same Rust diff as this head), in one goliath Ubuntu 22.04 X11 microVM (Xvfb, openbox, AT-SPI), same app window per pair. Eight measured pairs per app alternate order after one excluded warmup pair. Medians with the full min-max range; ranges do not overlap on any app.

| App | Elements | Main seconds, median [range] | This PR seconds, median [range] | Bus calls/element, main → PR |
|---|---|---|---|---|
| Kate 21.12.3 | 863 | 1.476 [1.450-1.631] | 0.684 [0.644-0.707] | 10.658 → 9.629 |
| Dolphin 21.12.3 | 500 | 0.858 [0.825-0.887] | 0.360 [0.345-0.399] | 10.508 → 9.170 |
| LibreOffice 7.3.7 Writer, GTK3 | 1,954 | 3.124 [3.041-3.340] | 1.567 [1.526-1.637] | 10.711 → 10.345 |
| LibreOffice 7.3.7 Writer, KF5 | 2,057 | 4.009 [3.927-4.233] | 1.970 [1.934-2.113] | 11.877 → 11.548 |

The real AT-SPI `ax::query` (`find`) path runs with limit 5,000 in identical test-profile builds, on a 300-line text file, a directory of 150 files and one 180-paragraph document per Writer backend. `dbus-monitor --profile` counts the reader's method calls per returned element; element and call counts are stable across pairs. No model runs.

A GTK 3 `TreeView` of 100,000 rows × 2 columns, same guest, three alternating pairs: `find()` stops at its 5,000-node budget on both, and both ask the table for 4,997 children by `GetChildAtIndex`, with `GetChildren` only on the registry and app roots. Main takes 7.97 s [7.89-9.05], this PR 4.65 s [4.64-4.77], with one more call per element (13.0 → 14.0: `GetInterfaces`, as every cell implements each interface asked).

Re-run on Linux at `630392e7f0f`: `cargo test -p pi-natives --lib desktop::linux` (133 passed; 35 ignored that each need their own X server), `cargo test -p pi-natives --lib desktop::ax` (48 passed), and Linux `rust-check` passed.

`an_element_is_read_in_two_rounds_and_only_on_its_interfaces` holds peer-to-peer D-Bus replies until every expected call arrives, and the reader signals each time it waits, so a read that waits on one reply mid-round fails the test instead of hanging. It requires `ChildCount` in round one and the bounded `GetChildAtIndex` in round two, and checks skipped interfaces and the unknown-interface fallback.

Not run: `bun check` (no TypeScript changes).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
