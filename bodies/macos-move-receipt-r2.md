## What

I made a background `win.move()` on macOS add one line to the run's output: the window was sent a pointer move, the user's pointer did not move, and AppKit views and web pages have shown no hover state for such a move, so a hover-only control may still be hidden. The line ends with `{ takeover: true }` as the route when a screenshot shows the control is hidden, or, under `computer.backgroundFallback: "refuse"`, with reaching the control through accessibility or telling the user. Nothing else changes: the same event is posted, with the same options, and a takeover move (requested, or the fallback's rerun) and every other backend print nothing new.

## Why

A background move used to return as a plain success. In the Cua Driver Bench hover-toolbar and tooltip tasks, 30 background moves meant to reveal a control each returned success while nothing appeared. In a macOS 26 guest, 10 tries per cell, the app's own log as the oracle:

| Hover zone | background `move` | `move({ takeover: true })` |
|---|---|---|
| AppKit tracking area | 0 of 20 | 20 of 20 |
| Chrome page (`pointerenter`) | 0 of 20 | 20 of 20 |
| Electron page | 0 of 20 | 20 of 20 |
| WKWebView page | 0 of 20 | 7 of 20 |

That is why the line says "may still be hidden" and names takeover only after a screenshot shows it, as the prompt's own rule for takeover does.

## Testing

Run through the computer tool in the same guest, this branch against `main`, 3 tries per cell on each of the four zones: a background move printed the line 12 of 12 on this branch and nothing on `main`; a takeover move printed nothing on either; no background move on either build produced a hover in the app's log.

`bun test test/tools/computer.test.ts -t "background move"`: the default and `takeover: false` moves print the line naming `{ takeover: true }`; under `refuse` it names the setting and no takeover; a requested takeover move, a fallback rerun and a non-macOS backend print nothing new. The test fails on `main` (no line).

No model sample set was run: the line appears only in a macOS run after a background move, and the transcripts it changes are the benchmark's hover tasks, which the benchmark lane re-measures after these fixes.

## Risk

The line is model-facing text on every macOS background move, once per call (a scripted path of N moves prints it N times, like the takeover fallback's notice). Rollback: revert.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

