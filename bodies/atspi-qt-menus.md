## What

I made Linux `menu.select()` walk into a Qt app's menus, because every path below a Qt menu bar was refused as if its first item were a command.

`W.menu.select(["File", "Mark"])` on a Qt 5 and a Qt 6 window: refused 80 of 80 times on `main`, pressed 80 of 80 with this PR, with no menu opened.

## Why

Qt 5 and 6 publish a menu bar item (`File`, role `MenuItem`) with one child of role `PopupMenu` that holds its items. The Linux menu walk (`menu_level` in `crates/pi-natives/src/desktop/linux/ax/menus.rs`) unwrapped a single `Menu` child, GTK's shape, and counted only menu roles as a submenu, so `File` read as a command and the walk stopped with "path traverses a command rather than a submenu". `submenu_role` now takes `Menu` and `PopupMenu` at both places.

Qt keeps the closed menu's items published, and pressing one (`Press`) triggers its action with nothing shown and no keyboard grab, so the existing ownership checks and the single declared activation still decide the press.

Builds on `atspi-unanswered-app` (queued), whose reply timeout bounds every call this walk makes.

## Testing

Capability-matrix cell `menu.select(["File", "Mark"])`, Ubuntu 22.04 arm64 microVM (Xvfb, openbox), the real eval path, n=10 per window state, the fixture's own action counter as truth. Both arms carry PR 18823, without which `main`'s reads crash Qt apps:

| Qt 5 and Qt 6 window | `main` | This PR |
|---|---|---|
| focused, unfocused, covered, user typing elsewhere | refused 80/80 | Mark pressed 80/80 |


- `a_qt_menu_bar_item_opens_its_popup_menu` serves Qt's shape over a peer-to-peer D-Bus connection: `menu.items([])` reads `File` as a submenu and `menu.items(["File"])` lists `File > Mark` and `File > Other`. With `PopupMenu` taken out of `submenu_role` it fails at the first read.
- `cargo test -p pi-natives --lib -- desktop::linux::ax` on current main 9f728bd56e (Linux): 26 passed. `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
