## What

I made computer input that already reached the app report as sent, even when a stop lands a moment later.

Before, a `computer` call whose keys or click had gone out could still throw `Cancelled` ("input may be partial") if Escape, an interrupt or a released task grant arrived during the short wait that follows the input. The model then had to treat a completed ⌘S or click as possibly unsent. Now that call returns its result, and the stop ends the next call instead.

| A stop arriving… | main | this PR |
|---|---|---|
| between keys of a chord or text | `Cancelled`, input partial | same |
| after the last key or click, during the settle or reply wait | `Cancelled` | call succeeds; the next call is stopped |
| during a read (screenshot, AX read) | `Cancelled`, frame discarded | same |

## Why

Brit's `78bf1669cc` made the macOS shortcut reply wait a plain sleep, but the desktop worker still checked the cancel token after every request, so a shortcut cancelled in that sleep came back `Cancelled` anyway. The same class sat in the waits after input: macOS takeover's front-app hold, the background guard's settle, the click and drag settles, X11's takeover restore, key settle, last-key confirmation and focus watch, and Windows takeover's settle.

- `Worker::execute` checks the token after a call only for reads, which must not commit a frame they were cancelled during.
- A new `control::settle` is the one wait used after input has gone out; it sleeps through a cancel. The X11 last-key confirmation runs under `control::cleanup` for the same reason.
- `run_then_settle` now takes the settle duration and serves both the background guard and takeover, so takeover also settles after a failed action before handing the front back (at most 40 ms).

Non-goals: a cancel between keys still stops and reports partial input. The JS `nativeCall` abort check is unchanged: an aborted run already rejects through its own race, and the run facade checks every awaited call too, so removing it changes nothing a script sees.

Reading order: `control.rs` `settle` → `mod.rs` `Worker::execute` → `macos/skylight.rs` `run_then_settle` and `with_foreground` → `macos/input.rs` → `linux/x11/{input,mpx,wm}.rs` → `win32/input.rs`.

## Testing

Failing before, on `main` plus only the tests (`cargo test -p pi-natives --lib`, macOS arm64):

- `desktop::capture_tests::a_shortcut_sent_before_a_cancel_reports_sent`: a fake backend posts the chord, then the session is cancelled; `main`'s post-call token check turns the call into an error. With the fix it returns `Unit`, and a request queued behind it under the same token is still `Cancelled`.
- `desktop::macos::skylight::tests::a_cancel_once_the_input_is_out_keeps_it_through_the_settle`: the action cancels after posting; `main`'s cancellable `FOREGROUND_SETTLE` wait turns `Ok(7)` into an error. With the fix it stays `Ok(7)`.

With the fix both pass, as does the rest of `cargo test -p pi-natives --lib` (807 of 808) except `a_click_placed_in_the_users_app_does_not_let_the_target_keep_the_front`, which fails the same way on `main` without this change. `CI=1 bun check`, `bun run build:native` and the computer tool's bun tests (112) pass.

Not run: the Linux X11 and Windows changes were not compiled or run here (macOS host only); CI covers them.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
