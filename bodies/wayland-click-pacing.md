## What

Double clicks from computer use on KDE Wayland were quietly landing as single clicks, so I paced the libei clicks the way our X11 XTEST path already does.

On KDE Plasma 6.8, `computer.doubleClick` on a word in Kate selected it in 0 of 8 tries on `main` and 8 of 8 with this PR; GNOME stayed 8 of 8.

| Live trial, 8 runs each | `main` | this PR |
|---|---|---|
| KDE Plasma 6.8.2 (kwin 6.8.2), Kate: `doubleClick` selects the word | 0/8 | 8/8 |
| GNOME 50 (mutter 50.6), gedit: same trial | 8/8 | 8/8 |

- `crates/pi-natives/src/desktop/linux/wayland/libei.rs`: the Click branch of `Libei::pointer` now goes through a new `pace_clicks`. Each press is held `CLICK_DELAY` (12 ms), later clicks wait `MULTI_CLICK_GAP` (50 ms), and every frame gets a fresh timestamp. These are the values `xtest_gesture` in `linux/x11/input.rs` uses.
- Hold, Drag, Move and Scroll are unchanged.

## Why

On `main` a double click sent press, release, press and release back to back, with frame timestamps 1 µs apart. KWin stamps libei button events with its own clock as it reads them ([`eiscontext.cpp`](https://invent.kde.org/plasma/kwin/-/blob/master/src/plugins/eis/eiscontext.cpp), `pointerButtonChanged(…, currentTime(), …)`). The two presses therefore arrived in the same millisecond. Qt counts a double click only when the time between presses is positive ([`qguiapplication.cpp`](https://github.com/qt/qtbase/blob/dev/src/gui/kernel/qguiapplication.cpp), `processMouseEvent`), so every Qt app on Plasma saw two single clicks. The call still reported success.

PR 13881 fixed the same burst for drags.

Decisions:
- **Reuse the X11 numbers instead of tuning new ones.** 12 ms and 50 ms already ship there, and 50 ms is far inside Qt's default 400 ms double-click window.
- **Keep the cancel rules of PR 16202.** A cancel in a gap or a non-final hold releases the button and reports `Cancelled`. Once the last press is out, its hold always finishes, so a click that landed never reports `Cancelled`.

**Cost:** a single click takes 12 ms longer, a double click about 74 ms and a triple click about 136 ms.

Non-goals: the other Wayland computer-use gaps (no capture in released builds, the RemoteDesktop prompt per session).

## Testing

- The table's trial ran in Fedora 44 KVM guests through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built with `wayland-pipewire`), `main`'s addon against this branch's. Each run selected all, typed `alpha beta gamma`, double-clicked `beta`, typed `Q` and read the line back; it passes only on `alpha Q gamma`. Every KDE run on `main` gave `alpha Qbeta gamma`.
- Unit tests: `multi_click_presses_are_held_and_spaced_for_event_consumers` checks the order, the 12 ms hold and the 50 ms gap. `cancellation_releases_the_held_press_and_spares_a_click_that_went_out` covers a cancel before and after the last press; with the last hold made cancellable, its second case fails.
- `cargo test -p pi-natives --lib -- wayland::libei`: 9/9 pass on Linux. `scripts/rust-check` (clippy and rustfmt on the changed lines): clean on Linux.
- Not run: the full `bun check`. The change is in one Linux-only Rust file.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
