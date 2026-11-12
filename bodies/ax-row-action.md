## What

I made rebuilt table rows usable through their existing refs without letting a click silently select a neighbouring row.

| Activity Monitor, macOS 26, no model | A, 20 s wait | B, 20 s wait | B, random 0–6 s wait |
|---|---:|---:|---:|
| Trials | 40 | 40 | 25 |
| Dock inspector opened | 0 | 28 | 22 |
| `StaleRef` | 40 | 5 | 2 |
| `InputFailed` after the first press | 0 | 7 | 1 other [INFERENCE: InputFailed] |
| Wrong process opened | 0 | 0 | 0 |

After a 20 s wait, opening the intended process improved from 0/40 to 28/40. The seven `InputFailed` trials are intended refusals: another row moved under the point before the second press of the double-click, so no second press was sent; all seven count against the success rate.

A ref can follow a destroyed table row only when a whole-window read finds exactly one row with the same fields, including the PID, and the element occupies the same place in it. Each press checks the target app's row under the click point, refusing when another row is found.

## Why

Activity Monitor rebuilds its process table as it refreshes, destroying the elements previously read by `computer`. Name-only matching cannot distinguish a restarted process; clicking a remembered position can select a neighbour after sorting.

Requires `ax-ref-read-as` (entry A). This adds row following to its stale-ref checks, not general control replacement; changed or ambiguous rows still refuse. The hit test keeps existing behaviour when the app does not answer or reports no row, so this is not a guarantee against every app or every timing race.

Review first: `follow_row` in `desktop/ax.rs`, then `aimed_row` / `row_at` in `desktop/macos/ax.rs` and `aimed_row_check` in `desktop/macos/input.rs`. Cost is one probe per row-ref request, a window walk after destruction and a hit test per press.

## Testing

The table comes from live no-model VM runs: filter Activity Monitor to Dock, call `ax()`, wait, then double-click the `" Dock"` ref. A used addon `5adf609d41b6`; both B runs used addon `039cabd673`, not final head `2feb8cb60a4`. Since that B build, `582df89fe75` flattened the row-follow return type for clippy; later commits removed four tests and stored the pinned front snapshot in its existing wrapper instead of nested options, preserving the pinned/unknown/unpinned states.

The three retained B tests fail with row following and the row verdict disabled. Four tests that still passed that control were deleted rather than claimed as regression coverage.

Re-run on current main `53dd4c6a319` on bench-mac: `cargo test -p pi-natives --lib desktop::macos` passed 353 tests; `cargo test -p pi-natives --lib desktop::` passed 601, including the merged read-as refusal coverage and row-following tests. `rust-check` passed clippy and rustfmt on macOS (bench-mac), Linux and Windows (goliath).
`bun check` was not run: this is native Rust work. Live measurements above are historical and were not repeated after rebasing.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (added when the PR number is assigned)
