## What

I made `el.type`, `el.press` and `el.click` check which app you have in front before they ask the target app anything, the way `win.type` and `win.click` already do.

On macOS, background input refuses when the target app came to the front during the call, because that means you just picked it and are working there. Element calls read your front app only after asking the element's app for its window (and, for a click, its bounds). Those requests wait while the app is busy. If you switched to it during the wait, it already counted as your front app, and the input went into the window you had just picked instead of refusing.

|Call|`main`|this PR|
|---|---|---|
|`el.type` / `el.press` / `el.click`, the target app busy while you switch to it|front app read after the element lookups: the switch is missed and the input lands|front app read first: refuses with `BackgroundUnavailable`, nothing sent|
|`win.type` / `win.press` / `win.click`|front app read before any request to the app|unchanged|

Two small corrections ride along:
- When the element doesn't take focus, the error and docs now say no keys were sent. Before, they said nothing was sent, but the focus request had already reached the app.
- The `computer` tool prompt lists `el.selectText` among the element helpers again (it was dropped by mistake), and says a following `el.type` on that element replaces the selection.

## Why

The worker used to look up the element's window (and a click's bounds) and hand the result to the backend. Now `Backend::element_input` and the new `Backend::element_click` do those lookups themselves, so the macOS backend reads the front app first and passes that reading down, as the window calls do. On Windows, Linux and Wayland the lookups only move into the backend; delivery is unchanged.

Decisions:
- I moved the lookups into the backend instead of giving the cross-platform worker a "read the front app" step, because only macOS reads the front app.
- On macOS, `token.check()` and the Accessibility permission check now run before the lookups, so revoked Accessibility reports the permission error instead of an `AxFailed` from the lookup.

## Testing

- `element_calls_leave_the_elements_window_to_the_backend` covers `el.type` and `el.click`: the worker doesn't list windows before the backend runs. Each row fails with the old worker code put back, checked on bench-mac.
- The focus-refusal test asserts the new wording and fails with the old one.
- `cargo test -p pi-natives --lib`, `CI=1 bun check` and the computer TS tests on macOS. One test, `skylight::…a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front`, also fails on `main` 58349dc80d and isn't touched here.
- Live on a macOS VM, as a regression check: while the user types in their own app, 16 `el.type` calls go into one field of a background Chrome page whose other field has focus. They landed in the named field with the focused one left empty, 3/3 runs at this head. The race itself, the target app busy while you switch to it, wasn't reproduced live.
- Windows: `cargo check -p pi-natives --tests --target x86_64-pc-windows-gnu` passes. Not run on a Windows machine.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
