## What

A background drag on a web page's slider did nothing on macOS and still returned as done, so I made the drag check what it moved: a web slider the page ignored is stepped the rest of the way, and a control that did not move says so.

In an Electron window behind the user's, drags on range inputs went from 0 of 200 to 200 of 200 landing where they were aimed, and a slider that follows pointer events still moves 40 of 40, as on `main`.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/304b2093-6722-4294-befa-b35077de831b">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/b91aa502-acba-4750-a547-8eeb3c8a96b6">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/5313eae8-4b85-4f23-91d2-0e4ab2369443">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/4ae4bc9e-8159-4c97-9ec2-1b40fde89f65">
  <img width="780" alt="Decision flow. A drag that starts on no value control, or whose control moved, returns done on main and with this PR. A web slider the page left where it was is stepped to the value under the path's end with this PR (main returns done with the slider unmoved). Any other control that did not move throws InputFailed with this PR (main returns done)." src="https://github.com/user-attachments/assets/b91aa502-acba-4750-a547-8eeb3c8a96b6" />
</picture>

- **The pointer drag goes out as before.** A drag the page follows, a drag off any value control or with another button, is unchanged.
- **A web slider the page left behind is stepped on.** When a plain left drag on an `AXSlider` in web content (one that takes `AXIncrement` and `AXDecrement` and publishes its range) leaves it where it was, or at the value under the press, it is stepped from there to the value under the path's end. One drag takes at most 1,000 steps (a 0-1000 input's full range; 995 steps took 1.5 s per call, about 0.1 ms a step).
- **A control that did not move says so.** Any other left drag that starts on a control publishing a number (an AppKit slider, a scroll bar, a splitter) reads it after the release; when it has not changed, though the path moved and did not push the control against the end it sat at, the call throws `InputFailed` saying no change was observed, instead of returning as done.

## Why

An agent could not tell a drag that moved a slider from one that did not, so it reported settings changed that were not: during a background drag the real mouse button is up, and Chromium drops the moves. A takeover drag would take the user's pointer.

Pointer first, steps second: a page whose slider follows pointer events (an ARIA `role="slider"` built on `pointermove`) is moved by the drag on `main`, and a steps-first form refused it (Chromium turns `AXIncrement` into an arrow key it ignores), so steps go out only after the pointer did nothing.

Limits: a web slider that ignores both background pointer input and `AXIncrement` still fails, now honestly (`InputFailed`, nothing moved). A slider laid out right to left, pressed on its thumb, throws `InputFailed` rather than being stepped toward the mirrored value; one whose page takes the press is judged left to right.

## Testing

Electron 33 page, macOS 26.5 VM, 10 drags per cell in each of four conditions (focused, behind the user's window, covered, user typing); counts are drags that landed where aimed, times are medians per call.

| Drag | `main` | this PR |
|---|---|---|
| range input, 1 step | 0 of 40 (all returned done), 0.72 s | 40 of 40, 1.38 s |
| range input, 76 steps | 0 of 40, 0.71 s | 40 of 40, 1.45 s |
| 0-1000 input, 995 steps | 0 of 40, 0.72 s | 40 of 40, 1.51 s |
| step-5 input, to 40 | 0 of 40, 0.71 s | 40 of 40, 1.44 s |
| pressed off the knob (page took the press: 29), to 75 | 0 of 40, 0.72 s | 40 of 40, stepped on from 29, 0.85 s |
| ARIA slider moved by pointer events | 40 of 40, 0.71 s | 40 of 40, 0.76 s |

The added time on a range input is the read-back that sees the pointer did nothing (0.6 s) before the steps.

An AppKit slider drag, which the pointer moves, stays 40 of 40 on both, now confirmed by one read.

`cargo test -p pi-natives --lib -- desktop::macos`: 360 pass, covering the route choice and its off sides, where steps start, the step plan and bound, and refusals once the drag is out. clippy and rustfmt on macOS and Linux. Not run: the guidance change was not sampled against models.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
