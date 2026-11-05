## What

The computer prompt told agents screenshots save at full resolution, so when they needed a close-up they cropped the saved file and got a blurry 1280-wide frame; I changed the line to say what the file is and point them at `zoom`.

With the old line GPT-6.1 Sol cropped the saved PNG in 5 of 5 runs when asked for a legible region; with the new one it called `zoom` in 5 of 5.

```diff
- Screenshots save full resolution to a temp path; use `{ silent: true }` in loops.
+ A screenshot's `path` holds the delivered PNG (`width`×`height`, downscaled when needed to fit the capture caps), not a separate uncapped original; for detail, `zoom` instead of cropping that file. Use `{ silent: true }` in loops.
```

## Why

The worker writes the same capped frame it shows the model to `<tmpdir>/omp-computer-*.png` (`emitScreenshot`); `docs/tools/computer.md` already says capture is resized "before both saving and displaying". The prompt line was the only place claiming otherwise. An agent filed it after a Retina Ghostty window (3152×1780 native) left a 1280×723 file and no full-resolution one.

Decision: correct the text rather than also save the uncapped capture. The saved file's pixels are the coordinate frame clicks use, `zoom` already returns native detail for a region, and a second full-size encode and write on every capture (silent loops included) would cost time and temp space for a file few calls need.

Non-goal: no change to capture, caps or `zoom`.

## Testing

- Live on macOS: `win.screenshot()` of a 1728×33 pt Retina window wrote a 1280×24 PNG to `path`; `win.zoom({x: 0, y: 0, width: 200, height: 24})` wrote 540×66, so `zoom` is the route to native detail the new line names.
- Behaviour, one turn, 5 runs per cell, low thinking: `omp -p --no-tools --system-prompt <computer.md from main or this branch>`, given a scaled screenshot result and asked for the next Eval cell. Scored by whether the code calls `zoom` or crops the saved file.

| Case | Model | `main` | This PR |
|---|---|---|---|
| Sharp image of a dialog region for a bug report | GPT-6.1 Sol | 0/5 zoom (5 crop the file with sharp or sips) | 5/5 zoom |
| Sharp image of a dialog region for a bug report | Haiku 5.5 | 5/5 zoom | 5/5 zoom |
| Read tiny status-line text | GPT-6.1 Sol | 5/5 zoom | 5/5 zoom |
| Read tiny status-line text | Haiku 5.5 | 5/5 zoom | 5/5 zoom |

No code changed, so no unit test.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
