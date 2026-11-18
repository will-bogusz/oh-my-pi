## What

A macOS background key, typed text or held key made the target window key with an activation event plus a press just outside its frame. Keys into a window that already is its application's key window now go out without the press, so I no longer see that window flash in front of the one I am typing in.

The rule is narrow: keys skip the press only when the application reports the target as its focused window, read after the activation event inside the same guard the keys go out under. If another of its windows is key, the press is still what makes the target key, so it stays. Without it the keys waited for a key window that never came and the call fell back to takeover (5 of 10 tries in each probed cell). Pointer input, menus and press-and-hold gestures keep the press as before.

## Why

That press lets the application order the window over the one I was typing in. The window-order fix (#19532) puts mine back within 13 to 50 ms, but the target still shows in front meanwhile, and for keys into a window already key the press does nothing: the activation event alone lets the application take them.

## Testing

On a macOS 26.5 VM, each target sat behind my app's front, key window while a simulated person typed 36 characters into my app during every call. There were 10 tries per cell, with this change's build interleaved against the window-order change's head. "Raised": the target topmost in a 10 ms window-list sampler, and on a 50 ms grid as a benchmark checker samples. "Press": presses the target app received.

| Target, input | Keys arrived | Raised, 10 ms / 50 ms: before → after | Press: before → after | Call ms: before → after |
|---|---|---|---|---|
| AppKit text view: x, X, Return, Tab, Right, Escape, ⌘A | 10/10 each, both builds | 0 / 0 → 0 / 0 | 10 → 0 | 586–767 → 587–767 |
| Electron field: the same seven, and 20 typed characters | 10/10 each, both builds | 9–10 / 1–6 → 0 / 0 | not visible | 592–976 → 594–975 |
| Chrome field: x, and 20 typed characters | 10/10 each, both builds | 9–10 / 3–4 → 0 / 0 | not visible | 621, 987 → 624, 984 |
| SwiftUI field, sheet field: x | 10/10 each, both builds | 0 / 0 → 0 / 0 | 10 → 0 | 649, 667 → 651, 675 |
| Target not key (another window of its app is) | 10/10, both builds | 9–10 / 8 → 10 / 7–8 | 10 → 10 | 703 → 702 |
| Two calls, the app moving its key window away between them | 10/10 both calls, both builds | — | after: none on the first call, one on the second | 1317 → 1307 |
| Two calls, the second into the window the first made key | 10/10 both calls, both builds | — | after: one on the first call, none on the second | 1321 → 1318 |

In every cell on both builds, my app stayed in front with its key window, and my next keys went into it. My typing lost no more than the no-call baseline (5 of 36 lost, 5 extra) in 20 of 20 tries.

On the benchmark this matters little. In the re-measure with the window-order repair in, keys and typing on Electron and Chrome raised the target in 2 of about 83 actions, and removing them would flip 0 trials; the raises that remain are mostly pixel clicks.

`cargo test -p omp-natives --lib desktop` on macOS: 722 pass; the 2 failures, `desktop::macos::input` Unicode-typing tests, fail the same on `main`. The same holds on the tree merged with #17756. The tests on `needs_press` and `key_without_press` fail with the rule reverted to always pressing (the skip test) and to never pressing (the not-key test); a panel another process draws, such as a system Save sheet, keeps the press. Clippy and rustfmt are clean on macOS and Linux.

## Risk

Review first: `needs_press` and where `make_key_in_background` calls it. A key window that changes after the read and before the keys stops the keys rather than misrouting them: `await_key_destination`, and `keys_still_reach` before every press, still have to see the target as key. Limits: LibreOffice Calc was not measured, because its welcome dialog sat attached to the sheet; a system Open or Save panel keeps the press and was not measured; pointer clicks still raise the target briefly.

---
- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
