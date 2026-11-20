## What

On Windows, when my window covered Chrome, Edge or an Electron app, `computer` screenshots and `ax()` reads of it came back as ok but showed the page from before it was covered, so I'm making both say so and say how to get a current view.

A covered Chromium window's screenshot or tree was a plain `ok` with old content in 114 of 120 trials on Windows 10 and 113 of 120 on Windows 11 with v19.0.1, and none with this PR; every one of the 120 reads on each system carried the mark.

| Chrome, Edge or Electron window | `main` | this PR |
|---|---|---|
| fully covered: screenshot / zoom | `ok`, a frame from before the cover | the same frame, `covered: true` and a note |
| fully covered: `ax()` | `ok`, the tree from before the cover | the same tree, ending with a `… covered:` line |
| any column of it showing | current | current, no mark |
| WinForms or WPF under the same cover | current | current, no mark |

<details><summary>The note (the tree's closing line says the same for the tree)</summary>

> window covered: this window appeared fully covered around the read, and Chromium can stop drawing a window it finds covered, so this capture and the window's ax() tree may be stale; while it stays covered, do not wait and read it again by any route (screenshot, ax(), find), since those may be stale too. To see its current state, read the page with the browser tool if it is connected to this app; otherwise raise() the window (it comes in front of the user's windows and takes their keyboard; Windows refuses it while they are using another window) and read it again, checking for the state you expect rather than trusting the first read after it; otherwise go on without it, telling the user what you could not confirm

</details>

> **Windows context.** A window capture is DWM's last frame. Once nothing of a Chromium window is visible, Chromium can mark its pages hidden and stop painting and updating its tree; nothing fails. The mark comes from window geometry, so it says the read *may* be stale.

## Why

A model told a stale picture is current acts on it; covered browsers are normal in background work.

- Mark, not refuse: other apps' covered windows are current.
- Only Chromium windows (input routing's class check): no generic signal exists, since Windows.Graphics.Capture delivers frames whether or not the app drew.
- Fully covered only: with one column showing, Chromium keeps drawing.
- No fresh-frame route: `PrintWindow` and Windows.Graphics.Capture return the old frame (0/30 each, 10 and 11); routes that work fake a system-wide event, change how the user's app runs, or are the browser tool's.
- The note tells the model not to wait and re-read while covered, and to check the expected state after a `raise()` rather than trust the first unmarked read.

Maintenance: if Chromium stops pausing, the mark is a harmless caution.

## Testing

Rig: Windows 10 22H2 and 11 VMs, Chrome/Edge/Electron/WinForms/WPF fixtures, a simulated user typing into a full-screen window, OMP's `eval` path; each trial changes the page, then reads it; v19.0.1 and this PR interleaved, n=10 per cell.

<details><summary>Windows 10 cells</summary>

| fixture | cell | condition | v19.0.1 | fix |
|---|---|---|---|---|
| chromium-page | PM-shot | covered | 10 false-success | 10 flagged |
| chromium-page | PM-shot | unfocused | 10 correct | 10 correct |
| chromium-page | PM-shot | user-typing | 10 false-success | 10 flagged |
| chromium-page | PM-tree | covered | 1 correct, 1 crashed-app, 1 disturbed-user, 7 false-success | 1 crashed-app, 8 flagged, 1 wrong-target |
| chromium-page | PM-tree | unfocused | 8 correct, 1 disturbed-user, 1 false-success | 8 correct, 2 disturbed-user |
| chromium-page | PM-tree | user-typing | 10 false-success | 10 flagged |
| edge-page | PM-shot | covered | 10 false-success | 10 flagged |
| edge-page | PM-shot | unfocused | 10 correct | 10 correct |
| edge-page | PM-shot | user-typing | 10 false-success | 10 flagged |
| edge-page | PM-tree | covered | 10 false-success | 1 crashed-app, 9 flagged |
| edge-page | PM-tree | unfocused | 8 correct, 2 false-success | 8 correct, 2 false-success |
| edge-page | PM-tree | user-typing | 10 false-success | 1 correct+marked, 1 crashed-app, 1 disturbed-user, 7 flagged |
| electron | PM-shot | covered | 10 false-success | 10 flagged |
| electron | PM-shot | unfocused | 10 correct | 10 correct |
| electron | PM-shot | user-typing | 1 crashed-app, 9 false-success | 1 crashed-app, 9 flagged |
| electron | PM-tree | covered | 10 false-success | 10 flagged |
| electron | PM-tree | unfocused | 9 correct, 1 harness-error | 10 correct |
| electron | PM-tree | user-typing | 2 crashed-app, 8 false-success | 1 crashed-app, 8 flagged, 1 wrong-target |
| winforms | PM-shot | covered | 9 correct, 1 false-success | 10 correct |
| winforms | PM-shot | unfocused | 10 correct | 10 correct |
| winforms | PM-shot | user-typing | 10 correct | 10 correct |
| winforms | PM-tree | covered | 10 correct | 10 correct |
| winforms | PM-tree | unfocused | 10 correct | 9 correct, 1 disturbed-user |
| winforms | PM-tree | user-typing | 10 correct | 9 correct, 1 crashed-app |
| wpf | PM-shot | covered | 9 correct, 1 crashed-app | 10 correct |
| wpf | PM-shot | unfocused | 10 correct | 10 correct |
| wpf | PM-shot | user-typing | 9 correct, 1 crashed-app | 10 correct |
| wpf | PM-tree | covered | 8 correct, 1 crashed-app, 1 void | 10 correct |
| wpf | PM-tree | unfocused | 9 correct, 1 crashed-app | 10 correct |
| wpf | PM-tree | user-typing | 10 correct | 10 correct |
</details>

<details><summary>Windows 11 cells (head ddaed5d)</summary>

| fixture | cell | condition | v19.0.1 | fix |
|---|---|---|---|---|
| chromium-page | PM-shot | covered | 8 false-success, 1 harness-error, 1 void | 10 flagged |
| chromium-page | PM-shot | unfocused | 10 correct | 10 correct |
| chromium-page | PM-shot | user-typing | 10 false-success | 10 flagged |
| chromium-page | PM-tree | covered | 10 false-success | 10 flagged |
| chromium-page | PM-tree | unfocused | 8 correct, 1 disturbed-user, 1 wrong-target | 8 correct, 2 disturbed-user |
| chromium-page | PM-tree | user-typing | 9 false-success, 1 harness-error | 8 flagged, 2 harness-error |
| edge-page | PM-shot | covered | 1 crashed-app, 8 false-success, 1 wrong-target | 10 flagged |
| edge-page | PM-shot | unfocused | 10 correct | 10 correct |
| edge-page | PM-shot | user-typing | 9 false-success, 1 harness-error | 10 flagged |
| edge-page | PM-tree | covered | 10 false-success | 10 flagged |
| edge-page | PM-tree | unfocused | 5 correct, 1 crashed-app, 4 false-success | 8 correct, 2 false-success |
| edge-page | PM-tree | user-typing | 10 false-success | 2 crashed-app, 8 flagged |
| electron | PM-shot | covered | 9 false-success, 1 harness-error | 10 flagged |
| electron | PM-shot | unfocused | 10 correct | 10 correct |
| electron | PM-shot | user-typing | 10 false-success | 10 flagged |
| electron | PM-tree | covered | 10 false-success | 10 flagged |
| electron | PM-tree | unfocused | 10 correct | 10 correct |
| electron | PM-tree | user-typing | 10 false-success | 1 disturbed-user, 9 flagged |
| winforms | PM-shot | covered | 10 correct | 9 correct, 1 false-success |
| winforms | PM-shot | unfocused | 10 correct | 10 correct |
| winforms | PM-shot | user-typing | 10 correct | 10 correct |
| winforms | PM-tree | covered | 9 correct, 1 void | 10 correct |
| winforms | PM-tree | unfocused | 10 correct | 10 correct |
| winforms | PM-tree | user-typing | 10 correct | 10 correct |
| wpf | PM-shot | covered | 10 correct | 9 correct, 1 disturbed-user |
| wpf | PM-shot | unfocused | 10 correct | 10 correct |
| wpf | PM-shot | user-typing | 10 correct | 9 correct, 1 false-success |
| wpf | PM-tree | covered | 9 correct, 1 crashed-app | 9 correct, 1 crashed-app |
| wpf | PM-tree | unfocused | 10 correct | 9 correct, 1 crashed-app |
| wpf | PM-tree | user-typing | 10 correct | 10 correct |
</details>

Windows 10 `PM-shot` fix rows ran ddaed5d's TypeScript with 5c95347's addon in both rounds (Rust differs only in the tree note); its `PM-tree` fix rows ran ddaed5d's own addon. Other misses occur on both builds, in code this PR leaves alone.

One column outside the cover (n=5): Chrome current 5/5 and 4/4 (one void), Electron 5/5 and 5/5; fully covered 0/20.

`raise()` while the user worked elsewhere: refused 75/75 (`InputFailed … (foreground lock)`).

Sample set (`omp -p`, covered Chrome after a background Save, a task needing a current look; Haiku 5.5 and GPT-6.1 Sol, n=3 per cell): `main` re-read the window 18/18; this PR re-read 0/24, told the user what it could not confirm 18/18 with them typing, and with them away raised Chrome 5/6. A draft saying only "do not read it again" left Haiku re-reading by `find` or wait-then-read 2/12.

Unit tests: 223 passed on Windows 10 (this head), 222 on 11 (ddaed5d), with `a_chromium_window_is_marked_only_when_nothing_of_it_shows` on ordinary overlapped windows; `a_covered_window_marks_its_capture_and_tree`; the worker test fails with `worker.ts` reverted.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
