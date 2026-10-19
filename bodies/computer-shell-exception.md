## What

I asked omp to open Finder to a video so I could drag it into Discord, and it spent 16 computer calls and two minutes clicking through Go to Folder, so this gives the computer tool a one-call way to open or reveal a file on macOS and points the prompt at it.

On macOS, a request to open a file, folder or settings URL, or to show a file in Finder, now goes out as one `computer.apps.open` call: Opus 5.5 did that in 1 of 20 runs on `main` and 20 of 20 with this PR.

| First desktop action the agent takes | `main` | this PR |
|---|---|---|
| Open/reveal tasks done in one call, Opus 5.5 | 1/20 (19 start driving Finder or System Settings) | 20/20 |
| Open/reveal tasks done in one call, Haiku 5.5 | 27/50 | 50/50 |
| UI tasks where the agent reaches for AppleScript instead, Opus 5.5 | 3/32 | 1/32 |
| UI tasks where the agent reaches for AppleScript instead, Haiku 5.5 | 6/40 | 5/40 |

- `computer.apps.open(path, { app?, reveal? })` opens an existing file or folder, or a URL, in its default app or `app` through `NSWorkspace`, behind your app unless `activate: true`, and returns the app with the window titled with the item. Relative paths resolve against the session's folder.
- `reveal: true` shows the item selected in Finder, which comes forward, so `backgroundFallback: refuse` refuses it and it arms the Escape stop, like `activate: true`.
- An exact application ID or path still opens the application. Linux and Windows throw `Unsupported` for a URL, `app` or `reveal`.
- The computer-use prompt gains one sentence after the shell ban (in details).

**Beyond the new call:** on `main` an existing non-`.app` path passed to `apps.open` on macOS throws `InvalidTarget`; it now opens as a document.

<details><summary>Prompt text, before and after</summary>

> For host-desktop requests, NEVER substitute Browser, Bash, AppleScript, accessibility commands, or `screencapture` unless user requests that mechanism or it errors. **When the whole request is to open a file, folder or URL, or to show a file in Finder, make one `computer.apps.open(path, {reveal?})` call (macOS) instead of driving the UI.**

</details>

Reading order: `desktop/applications.rs` `open`; `desktop/macos/applications.rs` `open_document`, `showing`, `launch_services`; `desktop/mod.rs` `takes_over`; `worker.ts` `apps.open`.

## Why

The prompt forbids Bash and AppleScript for desktop requests, and no `computer` call opened a document, so "show me this file in Finder" became typing a path into Go to Folder.

- **Rejected: a shell exception in the prompt** ("run one `open` command when that does the whole job"). It fixed open/reveal as well, but all five wordings I tried made agents reach for AppleScript more on UI tasks (Haiku 37/160 against 6/40 on `main`; Opus 7/32 against 3/32).
- **Rejected: spawning `/usr/bin/open -R`.** `apps.open` already launches through `NSWorkspace` without activation and waits for the first window; reusing that keeps both.

Non-goals: Linux and Windows. Maintenance: both AppKit calls are long-stable; a failure surfaces as Launch Services' error.

## Testing

- Agent eval on `main`'s and this PR's exact prompt text, desktop side effects recorded, never sent (details).
- Live, macOS 26, this branch through `omp -p`: `apps.open("note.txt", { app: "TextEdit" })` opened a scratch file in 0.6 s behind the frontmost app (focus unchanged) and returned the window titled `note.txt`; `main` throws `InvalidTarget`.
- `computer.test.ts` 118 pass; the new path and refusal cases fail with the `worker.ts` change reverted. `desktop::applications` Rust tests pass on macOS and Linux (routing precedence, `Unsupported` off macOS, a revealed symlink stays the link); the Escape-stop test covers `reveal`.
- Not run: `reveal` live, since it brings Finder forward on the test machine; Windows was not built.

<details><summary>Eval method</summary>

Headless `omp -p` sessions in two agent configurations (an empty agent dir and a heavily customized one). Computer input was stubbed in the worker and `open`, `osascript` and similar commands blocked by an extension; the first desktop side effect per session was classified. Open/reveal tasks: reveal a PDF, the original Discord request, open a .txt in TextEdit, open a folder, open Sound settings (a copy-to-clipboard control was one call on both, 10/10, and is not counted). UI tasks: compute in Calculator, read and convert a TextEdit document, click a Finder sidebar item. Haiku 5.5 low, 10 runs per task per arm; Opus 5.5 medium, 4 per open/reveal task and 8 per UI task.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
