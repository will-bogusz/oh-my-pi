## What

I made computer input that already reached the app report as sent, even when a stop lands a moment later.

Before, a `computer` call whose keys or click had gone out could still throw `Cancelled` ("input may be partial") if Escape, an interrupt or a released task grant arrived during the short wait that follows the input. The model then had to treat a completed ⌘S or click as possibly unsent. Now that call returns its result, and the stop ends the next call instead.

| A stop arriving… | main | this PR |
|---|---|---|
| between keys of a chord or text | `Cancelled`, input partial | same |
| after the last key, click or tap, during the settle or reply wait | `Cancelled` | call succeeds; the next call is stopped |
| during a read (screenshot, AX read) | `Cancelled`, frame discarded | same |

## Why

Brit's `78bf1669cc` made the macOS shortcut reply wait a plain sleep, but the desktop worker still checked the cancel token after every request, so a shortcut cancelled in that sleep came back `Cancelled` anyway. The same class sat in the waits after input: macOS's hold after the last key, click or tap press and the chord's final check, takeover's front-app hold, the background guard's settle, the click and drag settles, X11's takeover restore, key settle, last-key confirmation and focus watch, and Windows takeover's settle.

- `Worker::execute` checks the token after a call only for reads, which must not commit a frame they were cancelled during.
- A new `control::settle` is the one wait used after input has gone out; it sleeps through a cancel. The X11 last-key confirmation runs under `control::cleanup` for the same reason.
- `run_then_settle` now takes a duration and serves the background guard and takeover, so takeover also settles after a failed action (at most 40 ms).
- A Screen Sharing key stopped by a held modifier after earlier keys went out now says they may already have landed, as the pointer recheck does.

Non-goal: a cancel between keys or clicks still stops and reports partial input. The settles also run in full after a cancelled action, adding up to 200 ms before the stop reports: a cancel can land after partial input, and the guard must still send back an app it brought forward.

<details><summary>Reading order, and why the JS abort check stays</summary>

`control.rs` `settle` → `mod.rs` `Worker::execute` → `macos/skylight.rs` `run_then_settle` → `macos/input.rs` `sent_gap_wait` → `linux/x11/{input,mpx,wm}.rs` → `win32/input.rs`.

The JS `nativeCall` abort check after a native call is unchanged: an aborted run already rejects through its own race, and the run facade checks every awaited call too, so removing it changes nothing a script sees.

</details>

## Testing

Failing on `main` plus only the tests, passing with the fix (`cargo test -p pi-natives --lib`, macOS arm64):

- `desktop::capture_tests::a_shortcut_sent_before_a_cancel_reports_sent`: the fake backend sends a chord, then the session is cancelled; `main` returns an error. A request queued behind it is still `Cancelled`.
- `macos::skylight::tests::a_cancel_once_the_input_is_out_keeps_it_through_the_settle`: `main`'s `FOREGROUND_SETTLE` turns `Ok(7)` into an error.
- `macos::input::tests::input_whose_last_key_is_out_is_not_reported_cancelled` and `a_click_whose_last_press_is_out_is_not_reported_cancelled`: text, a chord, Screen Sharing keys and a double tap cancelled at their last press; a cancel before it still stops.

The rest of the suite passes (884 of 885) except `iphone_mirroring_taps_and_scrolls_stop_once_the_user_brings_it_forward`, failing on `main` too. `CI=1 bun check`, `build:native` and computer bun tests pass.

Not run: the X11 and Windows changes were not compiled here (macOS only); the Screen Sharing wording was not checked on a live session.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
