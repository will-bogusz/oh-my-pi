## What

I made X11 typing put in characters the keyboard layout has no key for, like é, ö, ✓ or a Russian sentence on a US layout, because every such `type()` failed with "X11 keymap has no keycode for keysym 0xe9".

Typing `héllo wörld ✓` into a GTK 3, Qt 5, Qt 6 or Chromium field: refused 40 of 40 times on `main`, typed exactly 40 of 40 with this PR.

## Why

X11 typing presses keys, so `Keymap::plan_text` (`crates/pi-natives/src/desktop/linux/x11/keymap.rs`) refused a whole text when one character had no keycode. xdotool's answer is to bind the missing keysym to an unused keycode and restore it later; `TextMapping` (`linux/x11/text_mapping.rs`) does that, with the restore rules below.

- Bindings live for the session, not one call: an app translates a key against the keymap when it reads the event, so a row restored right after the key can be read empty (a receiver that read its keys only after the call lost characters when each run restored its rows). They are restored when the session closes, and a row is rebound only 500 ms after its last key went out.
- Only empty, non-modifier rows are taken; a text needing more than are free is typed in segments, evicting least recently used bindings first. Ownership checks and writes run under `GrabServer`, and a restore clears only rows that still hold our keysym, so another client's binding survives.
- Planning and binding happen before takeover activates the window, so a refusal moves no focus. XTEST and `XSendEvent` bind through the core keyboard; the MPX keyboards bind on their own device and its master.

Chords and holds of such characters still refuse, as on `main`. If omp is killed, the bound rows stay until `setxkbmap` reloads the layout; the no-free-row refusal says so. Element-takeover chords now plan on the XTEST device's keymap (`Keymap::xtest`), as text already did.

## Testing

Capability-matrix cell `type("héllo wörld")` after a click on the field, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, US layout), the real eval path, n=10 per cell, the fixture's field text as truth:

| Window | `main` | This PR |
|---|---|---|
| focused (GTK 3, Qt 5, Qt 6, Chromium 156) | refused 40/40 | typed exactly 40/40 |
| unfocused, same apps | took over, then failed 40/40 | took over, typed exactly 40/40 |

The takeover itself (focus moved while the user works) is unchanged; that is #18784's ground.


- Nine ignored Xvfb tests (`cargo test -p pi-natives --lib -- --ignored remap`): exact receipt through XTEST and `XSendEvent`, a receiver that reads only after the send, a Russian pangram longer than the free rows, cancellation and unwind, a foreign rebind surviving our restore, no `FocusIn` on a refused chord, one `MappingNotify` per batch, MPX restore. Each fails with its fix reverted.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
