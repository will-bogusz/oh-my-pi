## What

A background drag on a web page's slider did nothing on macOS and still returned as done, so I made the drag check what it moved: a slider the page ignored is stepped the rest of the way only when its direction is known, and a control that did not move says so.

Chromium thumb drags now throw `InputFailed` where the previous head reported them set: Chromium exposes no thumb position, so direction cannot be read safely. A value-changing track press can still establish direction; the error names arrow keys and accessibility increment/decrement actions as recovery routes.

The pointer still goes first. A slider it moved is left where it held, with its value in the result; a thumb-exposing slider left short is stepped toward the release, undoing one step and failing if it moves away. Each geometry step waits for its value to change and hold, not fifteen equal position reads.

## Why

A press on the track can move a slider away from its old limit even when the pointer moves toward that limit, and reversed sliders make an assumed left-to-right scale unsafe. Unknown direction fails rather than setting the mirrored value.

Native perpendicular drags and motion below one pixel along the track need no value change, as on main. Larger sub-step drags that leave the value unchanged still fail: accessibility cannot distinguish them from ignored input. Checkbox, splitter, other-platform and takeover paths are unchanged.

## Testing

Five regressions fail on the reviewed `cf1ce4ecf51` behavior, replayed unchanged onto current crate paths, and pass with the fix: off-thumb pinned bypass, reversed middle slider, wrong-way rollback, geometry wait count and sub-pixel progress. `cargo test -p omp-natives --lib desktop` on bench-mac: 714 passed; two existing newline/tab key-code tests fail identically on bare main `fcdfcce337c`.

Final-head native calls in an isolated macOS VM on bench-mac, with the fixture behind another app:

| Case | Observed result |
| --- | --- |
| Chromium, native range thumb/tiny drags, including a 0–1000 range and coarse steps | 40/40 `InputFailed`; DOM value 0 or 1 |
| Chromium, track press at 30%, release at 75% | 1/10 stepped to 75; 9/10 `InputFailed`, left at 29 |
| Chromium, pointer-handled straight/curved/partial controls | 40/40 done, retaining the observed 75, 56 or 40 |
| Chromium, native partial move | 10/10 `InputFailed`, left at DOM value 40 |
| Chromium, RTL thumb at value 40 | 10/10 `InputFailed`, value stays 40 |
| WebKit, exposed thumb; page prevents `mousedown` to exercise stepping | 10/10 done at 23 after 23 increments; same endpoint and step count in all three before runs |
| WebKit, RTL at 40 | 3/3 undo the first wrong-way step and throw `InputFailed`, restoring 40 |
| AppKit, perpendicular / sub-pixel / normal drags | 3/3 each return successfully |

Chromium's background AX value sometimes stays stale even when the DOM value moved; those calls remain unconfirmed rather than setting it again.

For the WebKit row, the median gap between DOM input events falls from **649 ms** (three run medians: 647–650 ms) to **48 ms** (ten: 46–49 ms). The native drag-call median falls from **15.56 s to 2.38 s**; both heads send 23 increments and finish at 23.

`bun test packages/coding-agent/test/tools/computer.test.ts`: 168 pass, using the addon built from this head on bench-mac.

Linux, macOS and Windows `rust-check` pass for the exact Rust diff. The tool-guidance change was not sampled against models.

---

- [ ] `bun check`: fails on main `08cb444207d` itself (six unrelated TS formatting files); the same files fail on this branch, with no failure in this PR's files
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
