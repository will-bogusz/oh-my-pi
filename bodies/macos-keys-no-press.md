## What

A macOS background key, typed text or held key made the target window key with an activation event plus a press just outside its frame. Keys into a window that already is its application's key window now go out without the press, so I no longer see that window flash in front of the one I am typing in.

Keys skip the press only when, read after the activation event inside the guard the keys go out under, the application reports the target as its focused window and something proves it draws its own content: the focused element maps to the window, or one of its first 16 accessibility children maps to it or to another window of its process. Anything unproven keeps the press, as does a system Open or Save panel another process draws, and a target another of whose windows is key (without the press the keys waited for a key window that never came, 5 of 10 tries per probed cell). Pointer input, menus and press-and-hold gestures keep the press.

## Why

That press lets the application order the window over the one I was typing in. `macos-window-order` puts mine back within about 15 ms, but the target still shows in front meanwhile, and for keys into a window already key the press does nothing: the activation event alone lets the application take them.

## Testing

On a macOS 26.5 VM, each target sat behind my app's front, key window while a simulated person typed 36 characters into my app during every call; 10 tries per cell, this build interleaved with the window-order head. "Raised": target topmost on a 10 ms sampler and on a benchmark checker's 50 ms grid. "Press": presses the target app received.

| Target, input | Keys arrived | Raised, 10 ms / 50 ms: before → after | Press: before → after | Call ms: before → after |
|---|---|---|---|---|
| AppKit text view: x, X, Return, Tab, Right, Escape, ⌘A | 10/10 each, both builds | 0 / 0 → 0 / 0 | 10 → 0 | 586–767 → 587–767 |
| Electron field: the same seven, and 20 typed characters | 10/10 each, both builds | 9–10 / 1–6 → 0 / 0 | not visible | 592–976 → 594–975 |
| Chrome field: x, and 20 typed characters | 10/10 each, both builds | 9–10 / 3–4 → 0 / 0 | not visible | 621, 987 → 624, 984 |
| SwiftUI field, sheet field: x | 10/10 each, both builds | 0 / 0 → 0 / 0 | 10 → 0 | 649, 667 → 651, 675 |
| Target not key (another window of its app is) | 10/10, both builds | 9–10 / 8 → 10 / 7–8 | 10 → 10 | 703 → 702 |
| Two calls, the app moving its key window away between them | 10/10 both calls, both builds | — | after: none on the first call, one on the second | 1317 → 1307 |
| Two calls, the second into the window the first made key | 10/10 both calls, both builds | — | after: one on the first call, none on the second | 1321 → 1318 |

My app stayed in front with its key window in every cell, and my typing lost no more than the no-call baseline in 20 of 20 tries. On the benchmark: keys and typing on Electron and Chrome raised the target in 2 of about 83 actions, flipping 0 trials.

The table predates the proof as it stands, when the rule copied every child of the window. The read per key call is now bounded: the focused window and element (at most 40 parents up), and only without proof there one more focused-window read and one `AXChildren` read capped at 16, with at most 16 window-id and owner lookups. Timed from a separate process making the same calls: 50–110 µs when the focused element proves it (a 2,004-child AppKit window, Chrome, Finder), against 4.5 ms for copying all 2,004 children; in all three both proofs hold. The capped read still makes the application build its whole list (4.3 ms at 2,004).

The `desktop::macos::{ax,input}` tests pass on macOS; `rust-check` on macOS and Linux.

## Risk

Review first: `key_without_press` and `ax::window_content_within`. A key window that changes after the read stops the keys rather than misrouting them: `await_key_destination`, and `keys_still_reach` before every press, must still see the target as key. Not measured: LibreOffice Calc, a system Open or Save panel (keeps the press).

---
- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
