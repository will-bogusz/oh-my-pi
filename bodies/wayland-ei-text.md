## What

I wanted the computer tool to type things like `äöü`, `日本` or an emoji on KDE Wayland, where it currently refuses them, so this sends that text through libei's text interface when the compositor offers one and keeps the existing refusal everywhere else.

| Text passed to `type()` | Behavior |
|---|---|
| Every character has a key in the active layout | Keystrokes, unchanged |
| Some character has no key; compositor offers `ei_text` | Commit the whole string as text |
| Some character has no key; no `ei_text` (GNOME, older KWin) | `InputFailed` before anything is typed |
| Such text contains line breaks or tabs | Refuse before sending; press Enter or Tab between calls |

Reading order: `plan_typing`, `text_runs`, then `Libei::type_text` in `wayland/libei.rs`.

## Why

libei normally presses keys from the active keyboard layout; a character with no key cannot be typed. libei 1.6 adds UTF-8 text commits, offered by KWin 6.8 but not Mutter.

This needs reis `=0.7.1`, replacing `=0.5.0`, with two API adaptations and an explicit `ei_device.ready` for its negotiated device version 3. reis never sends `ready` itself; without it version-3 devices never resume. KWin and Mutter negotiate version 2 today.

One call uses one route: mixing keys and text reordered every mixed line in Kate. Committed newlines do not submit forms, tabs do not move focus, and Kate dropped commits beginning with a newline, so those controls are refused. Runs preserve graphemes unless one exceeds the 254-byte request limit.

A successful text commit proves transport, not application delivery. Read back with observe/AX before relying on it; libei has no client-consumption acknowledgement.

## Testing

Fedora 44, Plasma 6.8.2, libei 1.6.0, through the RemoteDesktop portal:

| Target / input | Readback |
|---|---|
| Kate: `Hello äöü ß € ñ 日本 😀` | Exact text; main refuses at `ä` |
| Kate: Enter, then `zwei ä` | Exact text on a new line |
| Kate: `x\ny ä` | `InputFailed`, nothing typed |
| Native Wayland Konsole 26.08.2: `äöü ß € ñ 日本 😀` | Exact UTF-8 |
| XWayland xterm 411: same text | Eight `ESC[45~` sequences, no `€`; spaces survived |

Konsole and xterm calls both returned success. A process inside each terminal recorded the received bytes, with ASCII markers and Enter confirming the input target; screenshots corroborated the results.

libei's `eis-demo-server` exercised version 3 through `LIBEI_SOCKET`: `type("ab")` failed discovery without `ready`, then logged `text utf8 'ab'` with it.

Linux: `cargo test -p pi-natives` passed 606 tests at 48a32de1de. The text-run regression covers combining marks, a ZWJ emoji and a flag crossing byte 254, and an oversized grapheme. Linux, macOS and Windows `rust-check` passed. `bun scripts/gen-bazel-lock.ts --check` passed. GNOME was not run; the no-text-device refusal has unit coverage.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with attribution


