## What

When iPhone Mirroring shows "iPhone in Use" or "Connection Paused" instead of the phone, every click and key we sent reported success and went nowhere, so now input to that window fails and quotes what the mirror is showing.

On `main`, a tap sent while the mirror showed "iPhone in Use" returned success; with this PR it throws `InputFailed: window … is not showing the phone; no input was sent; connection state: "iPhone in Use …"` and sends nothing.

- `ax::require_phone_screen` (`desktop/ax.rs`) reads the top three levels of the window's accessibility tree (at most 64 nodes). Every connection screen recorded (Connection Paused, iPhone in Use, Timed Out, Connecting) is a picture with static text beside it under one element; the connected mirror exposes no children, and the Settings window has text but no picture. On that shape the call fails, quoting the text and naming the screen's buttons.
- `macos/input.rs` runs it first for pointer input, typing, shortcuts and held keys, only on iPhone Mirroring (`RemoteScreen::HidReports`).

## Why

An agent told a tap worked goes on as if the app opened. The phone becomes unreachable whenever the user picks it up, so this is common.

Decisions:
- Match the shape, not the titles: the screens are localized (the unit test uses French), and a picture beside text tells them from the Settings window, which an agent may drive.
- Report, never reconnect. Connecting needs the phone locked and plays its audio on the Mac ([Apple, iPhone Mirroring](https://support.apple.com/en-us/120421)), so the error says not to press the button while the user is using the phone.
- A window whose tree cannot be read takes the input as on `main`; only a cancel stops it.

Cost: one shallow accessibility read before each input call to iPhone Mirroring (trees of 1 to 6 nodes); other windows are not read. The check runs when a call starts, so a long `type` cut off mid-way by a pause is not caught.

## Testing

- Live, iPhone 16 Pro through iPhone Mirroring on macOS 26.1: on "iPhone in Use" a click and a `press` each threw the error with the state quoted, as did a scroll and a click on "Connection Paused". The fixtures follow the live trees of all four screens and the Settings window. At the head commit, connected: background and takeover taps, shortcuts and typing all went through unrefused; no connection screen came up, so the refusal was not re-measured on the final check.
- `ax.rs` tests: a localized screen with its picture after the text is refused with its text and button quoted; a bare window, the Settings shape, blank text and an unreadable node all pass. No unit test covers the `input.rs` call sites, which need a live `MacInput`. `cargo test -p pi-natives --lib desktop` on macOS and Linux; clippy and rustfmt on macOS, Linux and Windows.
- What an agent does with the error: given this error as a tool result while the user reads on their phone, Haiku and GPT-6.1 Sol each left the Connect button alone in 5 of 5 runs.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
