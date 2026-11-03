## What

`find()` gave up 24 levels below the window, so it never found VS Code's editor, which sits deeper, and I raised its limit to 64 levels.

| Live, VS Code 1.144 on GNOME 50 (Fedora 44 guest) | `main` | this PR |
|---|---|---|
| `find({ role: "textarea" })` | `[]` | the editor (`entry` "notes.txt") |

- `desktop/ax.rs`: `FIND_MAX_NODES` (5,000, as before) and `FIND_MAX_DEPTH` (64) replace the literals in `query` and in `refind`, which keeps reading at least as far as `find()`. This is shared code, so `find()` on macOS and Windows reaches 64 levels too.
- `ax()` keeps its default of 24 and its `maxDepth` option.

## Why

Electron nests its content deep: VS Code's tree goes 34 levels below the app, and GNOME Text Editor's (GTK4) reaches exactly the old limit, 24 below its window. The other trees measured stay well inside (Firefox 9 to 15 levels, LibreOffice 12 to 17, Kate 17, Dolphin 13, Chromium 11).

The node limit is what bounds `find()`'s work and stays at 5,000; the depth limit keeps that cap from turning into recursion depth in `walk_raw` (65 levels is about 75 KB of stack, against the session thread's 2 MiB). The Linux backend's ownership ascent also stops at 64. In a tree over 5,000 nodes the depth-first walk can now spend the budget below level 24; on a Chrome GitHub page that hits the cap, the deepest node was 21 and the nodes read were the same at 24 and 64.

## Testing

- Live in a Fedora 44 KVM guest (GNOME Shell 50.6) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives), `main`'s addon against this branch's, VS Code launched with `--force-renderer-accessibility`. Tree depths above come from a raw libatspi walk of each app.
- `find_reaches_content_as_deep_as_electron_nests_it`: a button 31 levels down is found, one past 64 is not; it fails with the limit back at 24. `a_ref_from_a_read_deeper_than_find_reads_is_searched_as_deep` now builds its tree past the new limit, so it still proves `refind` reads as deep as the read that made the ref.
- `cargo test -p pi-natives --lib -- desktop::ax`: 28/28. `scripts/rust-check`: linux, macOS and Windows clean.
- Not run: macOS or Windows apps live, the full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
