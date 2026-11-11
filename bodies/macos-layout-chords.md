## What

I wanted `win.press("cmd+a")` to select all on a French keyboard instead of quitting the app.

macOS character chords now use an operation-local read of the active layout, including desktop and background calls. Takeover resolves it after target focus, so per-document input-source switching cannot reuse the previous app's map.

- Command shortcuts use the layout's Command layer; bare characters get the Shift or Option they need.
- Control/Option shortcuts gain no unnamed modifier and reject numeric-keypad aliases, so AZERTY `ctrl+1` remains the number-row shortcut.
- Failed layout reads stop before sending keys. Characters absent from the layout, or layouts without key data, retain the ANSI fallback; character-free chords read no layout.

Local `type` still sends Unicode event text. Remote text retains its existing layout cache.

## Why

Local chords previously used US key codes: on French AZERTY, `cmd+a` arrived as Cmd+Q and quit the app, while `cmd+z` closed its window. Both could report success despite losing the user's work.

## Testing

Rechecked merge base `9369103e4a06` against final head `b4301e808147` in a fresh macOS 26.5.2 VM using TextEdit, with Finder in front before and after each cell. Each paired cell had 10 trials per route.

| French AZERTY | Base: background / takeover | Head: background / takeover |
|---|---|---|
| `cmd+a` selects all | 0/10 / 0/10; quit every time | 10/10 / 10/10; no quits |
| `z`, `1` type `z1` | `w&` 10/10 / 10/10 | `z1` 10/10 / 10/10 |
| `cmd+z` undoes | 0/10 / 0/10; window closed | 10/10 / 10/10 |

Automatic capitalization was disabled and TextEdit restarted before each typing cell; this is not a capitalization fix. Dedicated takeover undo passed 30/30 with no success-reported miss. Switching US → French → US between calls selected all on 30/30 calls in each route (10 sequences each).

Native macOS checks: `cargo test -p pi-natives --lib desktop::macos::keymap::tests::` (5 tests) and `cargo test -p pi-natives --lib local_chords_press_the_layouts_key_and_command_shortcuts_its_command_layer` pass. Production-only reversals fail the failed-read, stale-layout and keypad-shortcut regressions; macOS/Linux rust-check passed.

Limits unchanged: a character absent from the Command layer retains its ANSI key (`cmd+/` on German/AZERTY); keys held around clicks, drags and `holdMouse` still use ANSI keys.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
