## What

A background drag on a web page's slider did nothing on macOS and still returned as done, so I made the drag check what it moved. A slider the pointer moved is left where it held, with its value in the result; a control that did not move says so.

Chrome and Electron range inputs expose no thumb position. For those, the drag now hit-tests the slider at the release before reading it (Chrome keeps publishing the old value until a hit test reaches the slider), and when it does not read the release value, presses its track once there and reads the value back. The press sets the page's own value at that point whichever way the slider runs, so right-to-left and `writing-mode: vertical-lr` sliders need no direction guess.

A thumbless slider is never stepped. One the drag changed to the release value or its mirror is left as read; one still at its old value, or at any other value, throws `InputFailed` naming the value read and the recovery routes (arrow keys, `AXIncrement`/`AXDecrement`, takeover). A thumb-exposing slider (WebKit) left short is stepped toward the release as before, undoing one wrong-way step and failing.

## Why

Brit's four points hold, each with a test: `pinned` follows the release value (`a_track_press_away_from_the_thumb_is_not_pinned_at_the_old_limit`); a reversed slider is never stepped to the mirrored value (`a_press_only_drag_on_a_reversed_thumbless_slider_is_short_not_left`); a wrong-way geometry step is undone (`a_geometry_step_away_from_the_release_is_undone_before_failing`); and geometry steps wait only until the value changes and holds (`a_geometry_step_waits_only_until_the_changed_value_holds`), with a WebKit row below. The release press is sent only after re-hit-testing the same slider under the point and re-checking the user's front app around the hover and the press.

Setting `AXValue` does not reach the page in Chrome, Electron or WebKit (0/90 moved in each), and value-targeted stepping needs the release-to-value mapping that a thumbless slider cannot give, so neither is used here.

## Testing

Ten tries per cell, in an isolated macOS VM on bench-mac with the fixture behind another app; truth is the page's own value (DOM) or the AppKit slider's.

| Engine | Cells (LTR, RTL, vertical, vertical-lr, 0–1000, coarse, pointer-handled, track press, 60→20, 25→75) | Set and reported | Refused | Wrong value | Call median |
| --- | --- | --- | --- | --- | --- |
| Chrome 154 | 160 | 150 | 10 | 0 | 0.7–1.5 s |
| Electron 33 | 160 | 150 | 10 | 0 | 0.7–1.5 s |
| Safari WebKit | 160 | 150 | 10 | 0 | 0.6–0.8 s |
| AppKit | 50 | 50 | 0 | 0 | 0.7 s |

Every refusal is the fixture whose page ignores pointer input; WebKit's starts on an `AXGroup` and is refused before posting, as on main. The user's front app and pointer never changed. The previous head refused all 40 Chromium thumb drags and set 1 of 10 track presses.

New tests fail when their guard is reverted: release press, mirror and unchanged-value acceptance, the under-point recheck and its ordering around the front-app check. `cargo test -p omp-natives --lib desktop` on bench-mac: 742 passed; the two `desktop::macos::input` Unicode-typing tests fail the same on `main`.

Linux, macOS and Windows `rust-check` pass for the exact Rust diff. Not run: the previous head (`ade84edf5f3`) in this VM, `bun test`, and model samples of the tool-guidance change.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
