## What

I made takeover's refusal of a click on a macOS suggestion list, such as Safari's password autofill dropdown, say that the list is attached to the window it drops from and that a click without takeover reaches it. Before, it named only the window that held focus, or said the point had no identifiable window, and left the agent to guess.

| Safari autofill dropdown, takeover click | `main` | this branch |
|---|---|---|
| on the dropdown window | `InputFailed: window 62 could not be confirmed as the exact frontmost key window: its application's focused window is window 46 "Probe login"` | the same, then `; window 62 is attached to that window and does not become key, as a suggestion list does not: a click without takeover reaches it in the background` |
| through the page window, at the dropdown's point | `InputFailed: takeover point has no identifiable native window; no input was sent` | `InputFailed: takeover point is on window 62, which is attached to window 46; no input was sent: a click without takeover reaches it in the background` |

Nothing that takeover accepts or refuses changes: the dropdown can never become the key window, so the exact-key-window confirmation still refuses it, and no input is sent. Only the text changes, and only when `WindowServer` reports the refused window as attached, directly or through other attached windows, under the application's focused window (or, for the page-window route, under the target window) in the same process. Anything else keeps today's text.

## Why

A suggestion list is a child window of the field's window; it never takes key status, and a background click on it already works. An agent that tried takeover got a refusal with no next step and read the list as "flaky". Widening the confirmation to accept an attached window was considered and not done: the background click already reaches the list, so takeover there would buy nothing while loosening the one check that keeps takeover input out of the wrong window.

## Testing

- macOS 26.5.2 VM, Safari with a saved throwaway login: takeover clicks on the dropdown (13 tries) and through the page window at the dropdown's point (12 tries) were refused with the new text every time and filled nothing; on `main` each was refused 10/10 with the old text. A background pixel click on the dropdown window filled the login 10/10 on both.
- `cargo test -p pi-natives --lib -- names_the_background_route takeover_requires_exact_hit_test_ownership an_unconfirmed_key_window_names_what_held_focus_instead`: 4 pass on macOS. With the attachment check made to fail (`main`'s text), the two new tests fail.
- `rust-check` on macOS and Linux.

---

- [ ] `bun check` passes (no TypeScript changes)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
