## What

I kept seeing `computer.windows()` on Hyprland list every native Wayland window at the screen's top-left corner; this takes those windows' positions and sizes from Hyprland, read-only. What you get: listed positions for the windows their toolkit can't place. What you don't get yet: screenshots and crops of those windows still refuse exactly as on `main`, and their element bounds stay window-relative; that is a follow-up.

On Omarchy (Hyprland 0.56.2), listed bounds equal to Hyprland's go from **0/20 → 20/20**.

| Omarchy 4.5, n=10, builds alternating | `main` | this PR |
|---|---|---|
| `windows()` bounds equal to `hyprctl clients` (a GTK 3 app and Files) | 0/20, all at 0,0 | 20/20 |
| Two windows of one process with one title | 0,0 (20/20) | 0,0 (20/20), as `main` |
| Same cell's `ax()` tree and a button's `bounds()` | | identical to `main` 10/10 |
| `windows()`, median (range 6-64 ms both) | 13.5 ms | 11.4 ms |
| Hyprland stopped during the call (n=5) | 8 ms | same list as `main` 5/5, 1.05 s |
| GNOME 50, six calls × 3 rounds | | byte-identical to `main` |

> **Hyprland context.** A native Wayland app cannot learn where the compositor put it, so over accessibility (AT-SPI) its window reads 0,0. Hyprland knows each window's position, size, process and title, and serves them on a local socket.

**Compatibility:** on Hyprland, only `x`, `y`, `width` and `height` of windows whose toolkit gives no position change, in `windows()` and the handles `computer.window()` returns. All else is as on `main`.

## Why

- **Only the caller's list.** A new `Backend::listed_windows` serves `computer.windows()`; Wayland asks Hyprland there only. Captures, frames, AX roots and input keep reading `windows()`, AT-SPI's list, with no request.
- **Read only.** One request (`j/clients`), only when a listed window has no position, only to the `Hyprland` process serving the Wayland socket (peer credentials, every connection).
- **Never guessed.** A window takes a client only when exactly one Hyprland window of its process has its title.
- **Falls back whole.** No socket, no answer within 1 s (connect to last byte; the connect never waits), a reply over 16 MiB, a missing key or a negative size: the list is `main`'s.
- **Maintenance.** Hyprland's JSON is unversioned; this reads five long-standing keys (`mapped`, `at`, `size`, `pid`, `title`), pinned by a test on recorded 0.56.2 output.

Limits: a window being moved or resized is reported where Hyprland is taking it.

## Testing

- `cargo test -p omp-natives --lib desktop` on Linux: 364 passed (36 ignored, need Xvfb). New tests read recorded `j/clients` through a fake socket, refuse truncated, keyless and negative-size replies and a socket nobody accepts on, and pin which window takes which client. Undoing the change fails two: placement with placement off, and `only_the_caller_gets_the_listing_and_internal_lookups_read_the_backend` with the listing served by `windows()`.
- Live, this head against `main`, only the addon swapped: a GTK 3 window and a foot terminal on workspace 1, Files on 2, one GTK 3 process with two windows titled `TWIN`, focus moved each trial; one cell per build (`windows()`, the GTK 3 window's `ax()` and a button's `bounds()`), `hyprctl` read right after. Stopped: SIGSTOP before each cell, SIGCONT after; the list's SHA-256 matched `main`'s each trial. GNOME: SHA-256 per call.
- Not run: Hyprland 0.57, multiple monitors, macOS (shared code gains one defaulted trait method).
- `rust-check` on Linux and Windows.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
