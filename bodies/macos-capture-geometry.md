## What

I made macOS window screenshots show the whole window at its real size, including windows hanging off the screen or across two displays, so clicks aimed from them land where the agent meant.

In an 880 × 448 point TextEdit window, `win.screenshot()` drew the window into the box (29.5, 22.5)–(794, 412) on `main`; with this PR it fills (0, 0)–(880, 448).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/730717ff-36f5-4e65-ba91-ab485c1b56ea">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/f38aa33e-9a2b-4427-a4bb-39f84bdf77f5">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/cd1d836f-7d63-4cda-b505-42acd9010d6a">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/079adde9-21de-4fdc-8d00-858c36a922e5">
  <img width="780" alt="On main, macOS window screenshots shrink opaque window pixels inside the image, so clicks aimed from them miss. This PR restores their size: TextEdit goes from 80% of frame width to filling the frame, Messages from 94% to filling it, and iPhone Mirroring (measured with main's capture filter) from 76% to 96%, retaining its own transparent margin." src="https://github.com/user-attachments/assets/f38aa33e-9a2b-4427-a4bb-39f84bdf77f5" />
</picture>

| Window | Its pixels in its screenshot, `main` | This PR |
|---|---|---|
| On one display: TextEdit, Messages, a focused window | shrunk to 87–94% of the frame, 20–30 points in | fill the frame |
| Across a 2x and a 1x display, larger part on the 1x one | half size, in the top-left quarter | the whole window, filling the frame |
| Partly off screen | shrunk, off-screen part included | the whole window, off-screen part included |
| Covered by another window | shrunk | fill the frame |
| iPhone Mirroring, 418 × 920 | (50, 59.5)–(368, 750) | (8, 38)–(410, 912), the window's own transparent margin |

The capture helper (`capture/helper.m` `CaptureNext`) crops a window lying wholly on one display from that display, through a filter including only that window (`geometry.h` `WindowCaptureDisplay`); every other window goes through `main`'s desktop-independent filter, now with `ignoreShadowsDisplay` and `scalesToFit` set. Both return the window's frame, so the Rust side stays as on `main`.

## Why

Agents aim pointer input from the latest window screenshot. On macOS 26.1 the desktop-independent filter keeps the window shadow's extent despite `ignoreShadowsSingleWindow` and scales the padded window into the frame-sized image; `ignoreShadowsDisplay` drops the padding (FLTK sets it for the same reason). On 26.6 a window whose larger part is on a 1x display came out at half size, as `pointPixelScale` followed the 2x display; `scalesToFit` makes it fill the frame.

Decisions:
- A window on one display is still cropped from it: the independent filter shrinks a window and its sheet together when the sheet sticks out past the frame (a 780 × 416 print sheet on a 600 × 300 window); the crop cuts the sheet at the window's edge instead.
- No per-display crops for a window across displays: with "Displays have separate Spaces" (the default) macOS draws it on one display only, and capturing the other part fails (`SCStreamErrorDomain` -3811).

Known limit: a window across displays or partly off screen with a sheet larger than itself is still shrunk with the sheet (600 × 300 window at x = −250, 780 × 416 print sheet: drawn in (228, 0)–(522.5, 300)) until the sheet closes. `includeChildWindows = NO` would keep it exact but hide every sheet, including ones that fit and draw correctly now. A smaller sheet there maps exactly.

Not changed: desktop and display captures, Linux and Windows.

## Testing

- Live on 077868b466 (the same code as this head, before its rebase onto `main`), on macOS 26.1 (one Retina display) and macOS 26.6 (Retina plus a 1920 × 1080 display to its right): every case in the table, compared pixel by pixel with a display crop of its visible part: aligned at offset (0, 0), mean difference under 1 of 255.
- Capture time per call is unchanged: median 177–242 ms against 180–243 ms on `main` (26.1), 131–153 ms against 125–141 ms (26.6).
- Twelve background taps on iPhone Mirroring aimed from its capture touched the aimed spots within 2.5 points (earlier build, same route).
- `bun test packages/natives/test/macos-capture-geometry.test.ts` checks which windows `geometry.h` crops from a display, stacked displays included. `cargo test -p pi-natives --lib desktop` (macOS, 490 passed). Clippy and rustfmt on macOS, Linux and Windows.

<details><summary>Re-measuring a capture</summary>

Capture a window with `new DesktopSession().capture(id)` from `packages/natives`, take the bounding box of pixels with alpha above 200, and divide by the capture's scale (`width / displays[0].width`): on `main` the box sits inside the frame, with this PR it is the frame. `main`'s box depends on the window's shadow: 80% of the frame width for the focused TextEdit window in the image above, 87% for an unfocused one.

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

