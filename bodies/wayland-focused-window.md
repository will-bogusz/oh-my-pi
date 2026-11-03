## What

On GNOME and KDE Wayland, `computer.focusedWindow()` named the desktop shell whatever app I was in, so I made it name the focused application.

`focusedWindow()` returned gnome-shell's "Main stage" with gedit focused on GNOME, and an untitled `plasma-keyboard` frame with Kate focused on KDE, where `windows()` also marked two windows `focused: true`. Desktop and display `ax()` and `observe()`, which read the focused window, got the shell's tree too. Now they get the focused application window, and at most one window is marked focused.

| Live, `main` vs this PR | `main` | this PR |
|---|---|---|
| GNOME 50, gedit focused: `focusedWindow()` | `gnome-shell` "Main stage" | `gedit` "*notes.txt (~) - gedit" |
| KDE Plasma 6.8, Kate focused: `focusedWindow()` | `plasma-keyboard` "" | `kate` "notes.txt * — Kate" |

- `linux/ax.rs`: new `resolve_focus`, applied to Wayland's `windows()`. When several windows claim focus, frames owned by the process listening on `$WAYLAND_DISPLAY` (gnome-shell, read once with `SO_PEERCRED`) drop out first, then untitled frames, until one is left. A shell frame alone keeps focus, as in the GNOME overview. Two titled app windows leave none focused.
- `wayland/mod.rs`: display keyboard input (`focused_keyboard_window`) keeps reading the unresolved list, as on `main`.

## Why

`AtSpiAx::windows` marks a frame focused when it reports `Focused` or `Active`, and `focusedWindow()` takes the first. Both shells list first a frame that is always active, so the answer was always the shell.

Decisions:
- **Display keyboard input is unchanged.** A native app's frame has no known position, so the display check refuses it, while `main` passes GNOME through the shell frame. Letting it pass needs a count of the real outputs; the portal stream sees only one monitor.
- **On Plasma the socket's listener is `kwin_wayland_wrapper`,** which owns no frames, so KDE resolves through the title rule.

Non-goals: window positions, which native Wayland clients cannot learn.

## Testing

- Live in Fedora 44 KVM guests (GNOME Shell 50.6; Plasma 6.8.2 with accessibility on) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built with `wayland-pipewire`), `main`'s addon against this branch's at `d85d81096b5`. The cell prints `focusedWindow()` and every window's `focused` flag. The later tier order gives the same answer for both desktops' shapes (unit test below).
- `shell_frames_yield_focus_to_the_active_application_window` covers the GNOME and KDE shapes, the overview, two titled app windows, and an untitled app beside gnome-shell. The independent review reverted each rule in turn: no-op `resolve_focus` fails the GNOME case, no title rule fails KDE, naming the first app fails the two-app case.
- `cargo test -p pi-natives --lib -- desktop::linux` on Linux: 59/59. `scripts/rust-check` linux: clean.
- Not run: the full `bun check`, sway.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
