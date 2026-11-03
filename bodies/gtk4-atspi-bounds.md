## What

GTK4 apps like Files were close to unusable through the `computer` tool on X11: `ax()` called nearly every control disabled and every element click missed. I now place their elements from where the X server put the window and count `Sensitive` as enabled.

| Files on X11 | `main` | this PR |
|---|---|---|
| `ax()` lines marked `(disabled)` | 70 of 71 | 2 (Back and Forward, with no history) |
| `find()` bounds of the Downloads row | (0, 0, 168, 36) | (46, 542, 168, 36) |
| `ref.click()` on it | `InvalidCoordinateFrame`, nothing sent | Files opens Downloads |
| `computer.elementAt()` inside a gedit (GTK3) window | `multiple AT-SPI windows contain this point` | gedit's Open button |
| `computer.elementAt()` on the bare desktop | an element of Files | nothing |
| same, Files minimized | an element of Files | nothing |

> **AT-SPI context.** Elements report rectangles in screen or window coordinates. GTK4 answers only the second: screen is (0, 0) for every element, and `Contains` is true for any screen point (`gtkatspiutils.c`, unchanged on GTK `main`). The X server knows where the window is.

## Why

- **Which frames.** Those at screen (0, 0) whose `Contains` is true above and left of them; GTK3, Qt and Chromium keep `main`'s path, even maximized at the origin.
- **Where.** The X window is matched by process and title, as `window_id` does, and the frame must fill it, less any client-side shadow (`_GTK_FRAME_EXTENTS`); otherwise nothing changes. A minimized window holds no point.
- **Popovers stay as reported.** GTK before 4.18 measures them from the widget they hang off (fixed in `3b68c1ea`), so clicks under a `Popup` layer are still refused rather than sent elsewhere.
- **Hit tests.** A placed frame is tested against its rectangle and descended in window coordinates, stopping at a child whose extents miss the point (GTK4 offsets nested points twice).
- **Cost.** Frame and window lookups are cached until the next `window_root`; geometry is reread, so moves are seen. `find()` on Files: 275 → 430 ms (195 nodes); `ax()` stays ~260 ms.
- **Enabled.** AT-SPI allows `Sensitive` without `Enabled` on an operable control; greyed-out GTK3 and GTK4 controls have neither. Menu items follow: a GTK4 menu bar's `File` now lists as enabled.

Not covered: Wayland (no global position exists) and `GDK_SCALE` > 1 (sizes mismatch, so elements keep (0, 0); untested).

## Testing

Each test fails with its part reverted: `elements_reported_at_the_screen_origin_are_placed_by_their_window` (fake Files tree over peer-to-peer D-Bus: row, popover item, replaced window), `gtk4_frames_are_hit_tested_where_their_window_is` (GTK4, minimized and GTK3 frames; descent guard), `placement_fits_the_frame_to_its_native_window`, `sensitive_controls_are_enabled`.

Live on Ubuntu 24.04 (Xorg, openbox, picom; Nautilus 46.4, gedit 46.2) via the `DesktopSession` calls the `computer` tool makes: the table, a ref click after the window moved, Files' open popover still at (0, 0), and with shadows (gnome-system-monitor, extents 61, 61, 55, 67) Search at (872, 216) toggled by ref click. Not run: GNOME or KDE Xorg sessions.

`cargo test -p pi-natives --lib -- desktop::linux::ax`

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
