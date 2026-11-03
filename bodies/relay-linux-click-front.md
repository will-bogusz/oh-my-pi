## What

On Linux my agent kept yanking Chrome in front of the app I was typing in whenever it clicked in the tab Chrome was showing, and nothing told it that would happen, so the browser guide now says so and points it at the keyboard when I've asked to be left alone.

In a benchmark task where the user types notes in gedit while the agent fills and submits a form in the Chrome window behind it (Linux X11, mutter), the task passed in 0 of 5 runs on `main` and 7 of 8 with this PR, across GPT-6.1 Sol and Claude Haiku 5.5.

The agent's browser guide gains one line: which helpers press the mouse, and the keyboard route for each when the user must keep their app in front (`focus()` then `press("Enter")`, `press("Space")` for a checkbox, `uploadFile` on the file input). `docs/tools/browser.md` says the same.

## Why

- **Cause.** Since Chrome 150, on Linux and ChromeOS only, `ContentsWebView::DidGetUserInteraction` requests focus for the page's view on any mouse or touch press while it lacks focus ([chromium `ed05567436`](https://chromium.googlesource.com/chromium/src/+/ed05567436ea5cb1afaf32ee255fae6a58360709)). Under X11 that sends `_NET_ACTIVE_WINDOW` with a fresh timestamp, which mutter grants. A CDP press reaches the same observer, and every trusted press CDP can send is a mouse down or touch start, so nothing in omp avoids it; focus emulation doesn't either.
- **Rejected: putting the user's window back after Chrome takes it**, as the relay does for macOS popups. A script restoring gedit after each of 8 clicks cut the keys reaching the page from 158 to 14 of 175, and Chrome still held the front 11 to 21 ms per click. That still loses typing, and the X11 input code already decided against bouncing focus (`FocusSnapshot::check`).
- **Non-goal:** changing `click`. Off Linux X11 clicks don't raise Chrome, and with nobody typing elsewhere raising it is harmless.

## Testing

Raw CDP into Chrome for Testing 154 behind gedit (Ubuntu 24.04 Xorg + mutter VM; active window from `xdotool`, Chrome's X requests from `xtrace`):

| input to the tab the window shows | Chrome activated |
|---|---|
| `mousePressed`, left or right, on a button or blank page | 2/2 each |
| the same with `Emulation.setFocusEmulationEnabled` | 2/2 |
| `touchStart` | 1/2 |
| `mouseReleased`, `mouseMoved`, `mouseWheel`, key events, `element.focus()` | 0/2 each |
| `mousePressed` into a tab the window is not showing | 0/2 |
| native-Wayland Chromium 156 under GNOME (Fedora 44 VM) | no |

omp on `main` through the real relay, a mock-model eval cell on a borrowed shown tab while `xdotool` typed 307 characters into gedit: three `tab.click`s, or one `tab.check`, brought Chrome forward and gedit kept 55 and 58 characters; `focus` plus `press("Space", …)` toggled the checkbox and gedit kept all 307.

The task, a fresh VM per run, `main` 83de60ad99 alone and with this branch's `browser.md`, medium effort (two Sol `main` runs come from an earlier pilot on the same image and pin; half the PR runs had an earlier wording of the line, without the list of presses):

| model | `main` | this PR |
|---|---|---|
| GPT-6.1 Sol | 0/3: each clicked Submit, Chrome came forward, the notes were lost | 4/4: each submitted with `focus()` + `press("Enter")` |
| Claude Haiku 5.5 | 0/2: one clicked Submit; one never opened the browser tool and left the form unsent | 3/4: three submitted by keyboard; one never opened the browser tool |

Not run: KDE and sway Wayland, Chrome under XWayland. Chrome compiles the override only for Linux and ChromeOS.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
