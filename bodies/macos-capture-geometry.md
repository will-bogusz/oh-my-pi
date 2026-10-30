## What

Window screenshots on macOS drew the window shrunk inside the image, so every click an agent aimed from one landed tens of points off; I made the capture take the window at its real on-screen size so the pixels line up with the window again.

In an 880 × 448 point TextEdit window, `win.screenshot()` drew the window into the box (44.5, 30.5)–(749.5, 389.5) on `main`; with this PR it fills (0, 0)–(880, 448).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/730717ff-36f5-4e65-ba91-ab485c1b56ea">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/f38aa33e-9a2b-4427-a4bb-39f84bdf77f5">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/cd1d836f-7d63-4cda-b505-42acd9010d6a">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/079adde9-21de-4fdc-8d00-858c36a922e5">
  <img width="780" alt="On main, macOS window screenshots shrink opaque window pixels inside the image, so clicks aimed from them miss. This PR restores their size: TextEdit goes from 80% of frame width to filling the frame, Messages from 94% to filling it, and iPhone Mirroring (measured with main's capture filter) from 76% to 96%, retaining its own transparent margin." src="https://github.com/user-attachments/assets/f38aa33e-9a2b-4427-a4bb-39f84bdf77f5" />
</picture>

<details><summary>Exact boxes (window points)</summary>

| Window (frame, points) | Where its pixels sit in its screenshot, `main` | This PR |
|---|---|---|
| TextEdit, 880 × 448 | (44.5, 30.5)–(749.5, 389.5) | (0, 0)–(880, 448) |
| Messages, 1588 × 997 | (31.5, 24)–(1519, 958.5) | (0, 0)–(1588, 997) |
| iPhone Mirroring, 418 × 920 | (50, 59.5)–(368, 750) | (7.5, 37.5)–(410.5, 912.5), the window's own transparent margin |

Measured on an earlier build whose capture code is identical to this PR's. The iPhone Mirroring `main` box comes from a standalone ScreenCaptureKit capture with the desktop-independent window filter `main` uses; TextEdit and Messages are `main`'s own `win.screenshot()`.

</details>

- The capture helper (`capture/helper.m` `CaptureNext`, choice in `geometry.h` `WindowCaptureDisplay`) now captures a window through a display filter that includes only that window, cropped to the window's part on the display holding most of it. A window on no display keeps `main`'s desktop-independent filter.
- The helper reports the cropped bounds and the whole window (`screen_capture_kit.rs` `Captured`), and `FrameGeometry::for_window_capture` (`frame.rs`) maps screenshot pixels through the cropped part while resize checks still compare the whole window.

## Why

Agents aim pointer input from the most recent window screenshot, so a capture that draws the window 30 to 45 points in from its edges and scaled down sends clicks beside the control the model saw. `main`'s desktop-independent window filter does this on macOS 26: it shrank the window with and without `scalesToFit` and `ignoreGlobalClip`, while a display filter including only the window matched its frame.

Decisions:
- Capture the window from its display rather than correct the pixels afterwards: the shrink differs per window (TextEdit drawn at 80% of its size, Messages at 94%), so no fixed correction holds.
- A window straddling two displays shows only its larger part; clicks map through that part, and a part on the other display is not in the image.

Not changed: desktop and display captures, Linux and Windows, and a window that is not on screen (another Space, minimized), which keeps `main`'s filter.

## Testing

- Live on macOS 26.1 (Retina): `main`'s own `win.screenshot()` of TextEdit and Messages reproduced the boxes above; the PR's fill the frame. Twelve background taps on iPhone Mirroring, aimed at a lattice of points in the PR's capture, all touched the phone at the aimed spot (ring centroid within about 2.5 points).
- What the new filter keeps: a TextEdit window fully covered by another app still captures its own content, full frame; its Save sheet shows edge to edge, as it did shrunk on `main`. Not measured: a capture while the screen is locked.
- `cargo test -p pi-natives --lib desktop`: macOS 492 passed, Linux 208 passed, including `clipped_window_maps_capped_pixels_and_metadata_to_captured_bounds` and `clipped_zoom_rejects_changed_capture_offset_even_when_dimensions_match`. `bun test packages/natives/test/macos-capture-geometry.test.ts` compiles `geometry.h` and checks the display choice and crop. Clippy and rustfmt on macOS, Linux and Windows.

<details><summary>Re-measuring a capture</summary>

Capture a window with `new DesktopSession().capture(id)` from `packages/natives`, then take the bounding box of pixels with alpha above 200 and divide by the capture's scale (`width / displays[0].width`): on `main` the box sits inside the frame, with this PR it is the frame.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
