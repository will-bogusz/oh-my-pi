## What

On macOS a positive `dy` scrolled up while Windows and Linux scroll down, and both model families we asked write a positive `dy` to scroll down, so I flipped macOS to match the other platforms.

`win.scroll(400, 300, { dy: 300 })` on a TextEdit document moved it up on `main` (the visible text range went from offset 175 back to the start); with this PR a positive `dy` scrolls down and a positive `dx` right on macOS, as on Windows and Linux, with the user's Natural scrolling setting on or off.

**The decision this PR asks for:** macOS scripts written against the old sign now scroll the other way. The alternative is to keep macOS's sign and document it per platform, which leaves an agent's first macOS scroll going the wrong way (below).

- `quartz_scroll_deltas` (`macos/input.rs`) negates `dx` and `dy` once, for both macOS scroll paths: `global_scroll` (takeover, through `scroll_plan`) and `background_scroll`. iPhone Mirroring's scroll posts through `background_scroll`, so it follows.
- `docs/computer-use.md` states the sign for every platform.

## Why

The other backends already agree: X11 sends button 5 for `dy > 0` and button 7 for `dx > 0` (`x11/mpx.rs` documents "`dy > 0` scrolls down and `dx > 0` right"), Windows sends a negative `WHEEL_DELTA` per downward step, and libei takes the deltas as they are. macOS posted them straight onto Quartz wheel axes, which point up and left. No doc or prompt states a sign, and the macOS one dates from the first desktop backend, so nothing documented changes.

What agents write: given the `computer` tool documentation and asked for the one line that scrolls a TextEdit window down by 300 px, Haiku and GPT-6.1 Sol both wrote `scroll(400, 300, { dy: 300 })` in 5 of 5 runs each, with `main`'s documentation and with one that states the sign (20 of 20). On `main` that first scroll went up; a prompt line would not change what they write, so the PR adds none.

## Testing

| Background `scroll` in TextEdit (macOS 26.1), this change | Natural scrolling off | Natural scrolling on |
|---|---|---|
| `dy: +300` in a tall document (vertical scroll bar) | 0 → 0.037, down | 0.037 → 0.074, down |
| `dx: +200` in a wide one (horizontal scroll bar) | 0.029 → 1, right | 0 → 0.980, right |

A scripted run on a macOS 26.5 VM scrolled a list in an Electron page and in an AppKit app, 5 times in each of four conditions (target focused, behind the user's window, covered, the user typing elsewhere), with the list's real scroll offset as the check. Every call returned without an error on both builds:

| Background `scroll` on a list, rows correct of 20 | `main` | this change |
|---|---|---|
| Electron page, `dy: 3` at the top | 0, went up | 20 |
| Electron page, `dy: -3` at the top (nothing to scroll) | 0, went down | 20 |
| Electron page, `dy: -3` from 60 px down | 0, went down | 20 |
| AppKit table, `dy: 3` at the top | 0, went up | 20 |
| AppKit table, `dy: -3` at the top (nothing to scroll) | 0, went down | 20 |
| AppKit table, `dy: -3` from 60 px down | 0, went down | 20 |

On iPhone Mirroring a positive `dy` moved the phone's page down and a negative one back up, over 3 runs. Posted wheel events ignore the Natural scrolling preference, so no setting is read.

`scroll_deltas_map_down_and_right_to_negative_quartz_axes` (an out-of-range delta's error quotes the caller's value) and `paced_scrolls_go_down_and_right_as_negative_wheel_steps` (takeover); removing the negation fails both. `cargo test -p pi-natives --lib desktop` on macOS; clippy and rustfmt on macOS and Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
