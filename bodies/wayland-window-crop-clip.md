## What

A window hanging off the edge of its monitor came back as a crop labelled with the whole window's coordinates on Wayland and as an error on X11, so I made both capture the part you can actually see and map it with that part's own coordinates.

| A Linux window screenshot | `main` | this PR |
|---|---|---|
| Wayland, window past the monitor's right or bottom edge | the visible pixels, framed as the whole window: zoom and the reported bounds stretch them over the hidden part | the visible part, framed as that part |
| Wayland, window past the left or top edge (a window spanning two monitors) | `CaptureFailed` | the visible part |
| X11, window partly off the screen | `InvalidCoordinateFrame: target window was resized since capture` | the visible part |
| No part on the monitor, or no known position (Wayland) | `CaptureFailed` | unchanged |

This replaces #19584's refusal (by Deftera186, whose commit this branch carries and credits) with the visible part, keeping its integer arithmetic and its fractional-scale edge test.

> **Frame context.** Every screenshot comes with a frame: the map from its pixels to desktop points that zoom and coordinate input use. A window's frame is refused once the window is resized.

Reading order:
- `FrameGeometry::for_window_part` and `window_part` (`desktop/frame.rs`): a window frame holds the captured part, its offset in the window, and the whole window's size for the resize check. `for_window` passes the whole window, so macOS and Windows are unchanged.
- `PortalGeometry::window_crop` (Wayland): clips the window to the monitor, returns the crop and its frame.
- `X11Capture::capture`: passes the clipped area and the window's bounds, both read under the server grab.
- `capture_metadata` (`desktop/mod.rs`): reports the part's bounds and scale.

## Why

Wayland crops the portal's one-monitor image to the window, clipped at the right and bottom edges, but framed it as the whole window, so zoom and the returned bounds spread those pixels over the hidden part. X11 framed the clipped area but stored its size as the window's, so the resize check failed the screenshot that made it.

Refusing such a window, as #19584 does, leaves an agent no capture of a window mostly on screen. On Wayland each pixel edge is rounded from a clipped logical edge, so at 1.5x a part ending at the monitor's edge ends at the buffer's last pixel.

Non-goals: the hidden part from another monitor (the portal stream covers one; related: #13845) and Wayland window input, which stays refused.

## Testing

- `window_crop_clips_window_to_monitor_and_frames_the_visible_part`: windows past the right, bottom and corner edges of monitors at negative origins, at 1x and 1.5x; it checks the crop, the frame's bounds and resize check, and where the last pixel maps. With `main`'s logic it fails (bounds `(-101, -980, 400, 200)`, visible `(-101, -980, 101, 200)`).
- `window_partly_off_the_root_is_framed_as_its_visible_part` (Xvfb): a window at `(-50, -30)` captures 150×120 of its own pixels and maps `(10, 20)` to `(10, 20)`. With `main`'s X11 call it fails with "resized since capture".
- Xvfb with openbox through `createDesktopSession`, an xterm moved to `(-119, -18)`: omp 18.22.0's screenshot fails with that error; this branch returns its 245×246 visible part at `(0, 0)` and zooms inside it.
- `cargo nextest run -p pi-natives --run-ignored all -E 'test(/desktop::linux::wayland::|desktop::frame::|desktop::linux::x11::capture::tests/)'`: 76 passed. `rust-check` passed on Linux, Windows and macOS.
- Not run: a live portal capture on GNOME or KDE.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
