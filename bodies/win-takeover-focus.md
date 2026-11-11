## What

I made Windows element typing and key presses that run in takeover hand the keyboard back to the user's window, as every other takeover already does.

Element takeover now focuses the element inside the foreground guard: the guard saves the user's window and brings the target forward, then the element gets focus and the keys go out, then the user's window comes back. Window-level takeover input is unchanged.

Two edge cases now behave like window-level `type`: empty text sends nothing and no longer focuses the element, and an element whose focus opens a popup that takes the foreground stops with "the exact target lost foreground" before sending, then still hands the foreground back.

## Why

On Windows, `el.type()` and `el.press()` on an element without a window of its own (a field in Chrome, an Electron app, WPF or WinUI) always run in takeover: the background route refuses them, and the default `backgroundFallback` reruns them meaning to hand focus back afterwards. Focus never came back; the target window stayed in front with the user's keyboard.

UI Automation's `SetFocus` brings the element's window to the front, and the backend called it before the takeover guard read which window was in front. The guard saved the target as the user's window, so handing focus back to "the previous window" handed it to the target.

## Testing

Windows 11 guest, a Chrome for Testing page with one text field, Explorer in front as the user's window. 12 alternating `el.type` / `el.press` calls on the field per build, the foreground read before and after each:

| | `main` | this PR |
|---|---|---|
| Foreground back on Explorer afterwards | 0 of 12 (Chrome kept it) | 12 of 12 |
| Keys reached the field | 12 of 12 | 12 of 12 |

`element_takeover_hands_the_foreground_back_to_the_users_window` is a Windows desktop test, `#[ignore]`d because it opens two windows and moves the foreground. A copy of the test binary hosts two edit windows (the test's own windows would not be listed: `windows()` skips the calling process); the test makes three element inputs into one while the other is in front, then checks the foreground and both windows' text. Run it from a focused terminal with `cargo test -p pi-natives --lib element_takeover -- --ignored`. On the Windows 11 guest it fails with `main`'s order restored (the target is still in front after the first `type`) and passes on this branch.

`rust-check` on Linux and `rust-check --windows`: clippy and rustfmt clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated
