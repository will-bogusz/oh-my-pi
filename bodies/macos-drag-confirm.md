## What

A background drag on a web page's slider did nothing on macOS and still returned as done, so I made the drag check what it moved: a slider the page ignored is stepped the rest of the way, and a control that did not move says so.

In an Electron window behind the user's, drags on range inputs went from 0 of 200 to 200 of 200 landing where they were aimed, and sliders the pointer sets (straight or curved scale) still land 40 of 40, as on `main`.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/304b2093-6722-4294-befa-b35077de831b">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/b91aa502-acba-4750-a547-8eeb3c8a96b6">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/5313eae8-4b85-4f23-91d2-0e4ab2369443">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/4ae4bc9e-8159-4c97-9ec2-1b40fde89f65">
  <img width="780" alt="Decision flow. A drag that starts on no value control, or whose control moved, returns done on main and with this PR. A web slider the page left where it was is stepped to the value under the path's end with this PR (main returns done with the slider unmoved). Any other control that did not move throws InputFailed with this PR (main returns done)." src="https://github.com/user-attachments/assets/b91aa502-acba-4750-a547-8eeb3c8a96b6" />
</picture>

- **The pointer drag goes out as before**, and decides first.
- **A web slider the page left behind is stepped on.** When a plain left drag on an `AXSlider` in web content that takes `AXIncrement` leaves it where it was or at the value under the press, it is stepped to the straight-line value under the path's end while its first two steps are even, and the result says so; one exposing its thumb (WebKit's range input) is stepped until the thumb reaches the release. At most 1,000 steps (995 took 1.7 s per call).
- **A slider the pointer moved is left where it held.** The result names its value, and the straight-line value under the path's end when they differ.
- **A control that did not move says so.** Any other left drag starting on a control publishing a number (AppKit slider, scroll bar, splitter) that could have moved and did not throws `InputFailed` instead of returning as done.

## Why

An agent reported slider settings changed that were not: during a background drag the real mouse button is up, and Chromium drops the moves. The pointer goes first because a slider built on `pointermove` is moved by it on `main`.

Limits: a slider that ignores both pointer and `AXIncrement` fails honestly; a SwiftUI `Slider` ignores a background drag, so it fails honestly, and the same drag in takeover sets it (10 of 10); one laid out right to left, pressed on its thumb, throws `InputFailed` rather than being stepped toward the mirrored value.

Chromium shows a native range input and an ARIA slider identically (role, subrole, actions, attributes, no thumb), so a curved-scale slider that ignores the pointer but answers increments is set to the straight-line value, and told so. Without a thumb a part-way move cannot be told from a curved scale, so it is left where it held and reported. If a stale read makes the first two steps uneven, both are sent back and the slider is reported where the pointer left it.

## Testing

Electron 33, macOS 26.5 VM, 10 drags per cell in each of four conditions (focused, behind, covered, user typing); counts land where aimed, times are medians per call.

| Drag | `main` | this PR |
|---|---|---|
| range input, 1 step | 0 of 40 (all returned done), 0.73 s | 40 of 40, 1.45 s |
| range input, 76 steps | 0 of 40, 0.73 s | 40 of 40, 1.59 s |
| 0-1000 input, 995 steps | 0 of 40, 0.73 s | 40 of 40, 1.66 s |
| step-5 input, to 40 | 0 of 40, 0.73 s | 40 of 40, 1.58 s |
| pressed off the knob (page took the press: 29), to 75 | 0 of 40, 0.73 s | 40 of 40, stepped on from 29, 1.00 s |
| ARIA slider the pointer sets, to 75 | 40 of 40, 0.73 s | 40 of 40, 0.77 s |
| same, path end between two values (75.25, page rounds to 75) | 40 of 40 | 40 of 40, 0.77 s |
| ARIA slider on a curved scale the pointer sets to 56 | 40 of 40 | 40 of 40, 0.76 s |
| ARIA slider the pointer moves part-way (40 of 75) | returns done at 40, 40 of 40 | returns done at 40 naming the value and the straight-line 75, 39 of 40 (1 harness refusal) |
| range input the page moves part-way (40 of 75) | returns done at 40, 40 of 40 | returns done at 40 naming the value and the straight-line 75, 40 of 40, 0.98 s |
| SwiftUI `Slider`, background (focused, covered, unfocused, typing) | returns done at 0, 40 of 40 | `InputFailed` naming the value it reads, 40 of 40 |

Step-on costs about 1.5 s against `main`'s 0.73 s false success. The note's text is covered by unit tests only. AppKit slider: 40 of 40 on `main`, 10 of 10 on this head, 40 of 40 on the unchanged path earlier.

`cargo test -p pi-natives --lib -- desktop::macos`: 367 pass; `computer.test.ts` covers the note. The part-way range input and 76-step rows were re-run on this head; the rest on the commit before. clippy and rustfmt via `rust-check` on every platform the diff builds on. Not run: the guidance change was not sampled against models.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)



