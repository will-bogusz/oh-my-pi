## What

On Windows, when my window covered Chrome, Edge or an Electron app, `computer` screenshots and `ax()` reads of it came back as ok but showed the page from before it was covered, so I'm making both say so and say how to get a current view.

A covered Chromium window's screenshot or tree was a plain `ok` with old content in 114 of 120 trials on Windows 10 and 113 of 120 on Windows 11 with v19.0.1; with this PR none were, and 117 and 115 carried the mark (the rest: the app or harness stopped answering).

| Chrome, Edge or Electron window | `main` | this PR |
|---|---|---|
| fully covered: screenshot / zoom | `ok`, a frame from before the cover | the same frame, `covered: true` and a note |
| fully covered: `ax()` | `ok`, the tree from before the cover | the same tree, ending with a `… covered:` line |
| any column of it showing | current | current, no mark |
| WinForms or WPF under the same cover | current | current, no mark |

<details><summary>The note (the tree's closing line says the same for the tree)</summary>

> window covered: nothing of this window shows on screen, and Chromium stops drawing a window it finds covered, so this capture and the window's ax() tree can show the app as it was before it was covered; waiting and reading again return the same until part of the window shows. To see its current state, read the page with the browser tool if it is connected to this app; otherwise raise() the window and read it again (it comes in front of the user's windows and takes their keyboard; Windows refuses it while they are using another window); otherwise go on without it, telling the user what you could not confirm

</details>

> **Windows context.** A window capture is DWM's last frame. Once nothing of a Chromium window is visible, Chromium marks its pages hidden and stops painting and updating its tree; nothing fails.

Read `win32/window.rs` `fully_covered` first.

## Why

A model told a stale picture is current acts on it, and a covered browser is normal in background work.

- Mark, not refuse: the frame is the window's own, and other apps' covered windows are current.
- Only Chromium windows (the class check input routing uses): Windows.Graphics.Capture delivers frames whether or not the app drew, and hidden Chromium ignores redraw requests, so no generic signal exists.
- Fully covered only: with one column showing, Chromium keeps drawing.
- No fresh-frame route here. `PrintWindow` (either flag) and Windows.Graphics.Capture return the old frame (0/30 per route on 10 and 11). What works either fakes a system-wide move-size event, changes how the user's app runs (launch switches), or is the browser tool's (CDP).
- The note says reading again changes nothing, so models stop instead of looping.

Maintenance: if Chromium stops pausing, the mark is a harmless caution.

## Testing

Rig: Windows 10 22H2 and 11 VMs, Chrome/Edge/Electron/WinForms/WPF fixtures, a simulated user typing via QEMU into a full-screen window, OMP's own `eval` path. Each trial changes the page, then reads it; v19.0.1 and this PR interleaved, n=10 per cell.

<details><summary>Windows 10 cells</summary>

| fixture | cell | condition | v19.0.1 | fix |
|---|---|---|---|---|
| chromium-page | PM-shot | covered | 10 false-success | 10 flagged |
| chromium-page | PM-shot | unfocused | 10 correct | 10 correct |
| chromium-page | PM-shot | user-typing | 10 false-success | 10 flagged |
| chromium-page | PM-tree | covered | 1 correct, 1 crashed-app, 1 disturbed-user, 7 false-success | 10 flagged |
| chromium-page | PM-tree | unfocused | 8 correct, 1 disturbed-user, 1 false-success | 7 correct, 1 disturbed-user, 2 false-success |
| chromium-page | PM-tree | user-typing | 10 false-success | 1 crashed-app, 9 flagged |
| edge-page | PM-shot | covered | 10 false-success | 10 flagged |
| edge-page | PM-shot | unfocused | 10 correct | 10 correct |
| edge-page | PM-shot | user-typing | 10 false-success | 10 flagged |
| edge-page | PM-tree | covered | 10 false-success | 1 crashed-app, 9 flagged |
| edge-page | PM-tree | unfocused | 8 correct, 2 false-success | 7 correct, 3 false-success |
| edge-page | PM-tree | user-typing | 10 false-success | 10 flagged |
| electron | PM-shot | covered | 10 false-success | 10 flagged |
| electron | PM-shot | unfocused | 10 correct | 10 correct |
| electron | PM-shot | user-typing | 1 crashed-app, 9 false-success | 1 crashed-app, 9 flagged |
| electron | PM-tree | covered | 10 false-success | 10 flagged |
| electron | PM-tree | unfocused | 9 correct, 1 harness-error | 10 correct |
| electron | PM-tree | user-typing | 2 crashed-app, 8 false-success | 10 flagged |
| winforms | PM-shot | covered | 9 correct, 1 false-success | 10 correct |
| winforms | PM-shot | unfocused | 10 correct | 10 correct |
| winforms | PM-shot | user-typing | 10 correct | 10 correct |
| winforms | PM-tree | covered | 10 correct | 10 correct |
| winforms | PM-tree | unfocused | 10 correct | 10 correct |
| winforms | PM-tree | user-typing | 10 correct | 9 correct, 1 false-success |
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

Windows 10's fix side used 5c95347's addon (Rust differs only in the note's wording). The `unfocused` and WinForms/WPF misses occur on both builds, in code this PR leaves alone.

Partial cover (one column of the frame outside the cover, n=5): Chrome current 5/5 (10) and 4/4 (11, one void), Electron 5/5 and 5/5; fully covered 0/20.

`raise()` while the user worked in another window: refused 75/75 (`InputFailed … (foreground lock)`), hence the note's warning.

Sample set (`omp -p`, covered Chrome after a background Save, a task needing a current look; Haiku 5.5 and GPT-6.1 Sol, n=3 per cell): `main` re-read the window 18/18; this PR told the user what it could not confirm 18/18; with the user away, Sol raised Chrome 3/3. Without "reading again returns the same", Haiku re-read 9/9.

Unit tests: 222 passed on Windows 11 (head) and 10 (5c95347), with `a_chromium_window_is_marked_only_when_nothing_of_it_shows` on real windows; `a_covered_window_marks_its_capture_and_tree`; the worker test fails with `worker.ts` reverted.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
