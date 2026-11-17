## What

I made X11 typing put in characters the keyboard layout has no key for, like é, ö, ✓ or a Russian word on a US layout, because every such `type()` failed with "X11 keymap has no keycode for keysym 0xe9".

Typing `héllo wörld ✓` into a GTK 3, Qt 5, Qt 6 or Chromium field: refused 40 of 40 times on `main`, typed exactly 40 of 40 with this PR.

## Why

X11 typing presses keys, so `Keymap::plan_text` (`linux/x11/keymap.rs`) refused a whole text when one character had no keycode. xdotool binds the missing keysym to an unused keycode and restores it later; `TextMapping` (`linux/x11/text_mapping.rs`) does that. Bindings are kept after the call and reused, and restored when the session closes; a later call may take a row over once its last key is 500 ms old. The X server grab covers only keymap reads and writes: another X client now waits under 2 ms however long the text (91 ms for a million characters before).

Limits:

- A text needing more distinct characters outside the layout than there are spare keycodes (19 on Xvfb's default US layout) is refused before any key, saying how many fit. Typing it in runs that rebind rows mid-text garbled receivers that read late (cells below).
- Chords and holds of such characters still refuse, as on `main`. If omp is killed, the bound rows stay until `setxkbmap` reloads the layout; the refusal says so.
- A call that needs a row an earlier call used less than 500 ms ago waits out the rest before its first key, holding the cross-session input lease. A receiver stalled longer than that can read the earlier call's keys through the new keysym.

<details><summary>Binding rules</summary>

- An app translates a key against the keymap when it reads the event, so a row restored right after the key can be read empty: a receiver that read its keys only after the call lost characters when each call restored its rows.
- Only empty, non-modifier rows are taken, least recently used bindings evicted first. Ownership checks and writes run under `GrabServer`; the text's distinct keysyms are collected before it. A rebind owns the row under its old and new keysym until the write and read-back succeed, so a rejected or partial write is still restored; a restore clears only rows holding one of our keysyms, so another client's binding survives.
- Binding happens before takeover activates the window, and before a fresh MPX keyboard's warm-up key, so a refused text moves no focus and sends no key. XTEST and `XSendEvent` bind through the core keyboard; MPX keyboards bind on their own device and its master. Element-takeover chords now plan on the XTEST device's keymap (`Keymap::xtest`), as text already did.
- Session close (`DesktopSession.close()`) now returns a restore failure instead of dropping it.

</details>

## Testing

Capability-matrix cell `type("héllo wörld")` after a click on the field, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, US layout), real eval path, n=10 per cell, field text as truth, run at `509c34a737e`, before the rebase:

| Window | `main` | This PR |
|---|---|---|
| focused (GTK 3, Qt 5, Qt 6, Chromium 156) | refused 40/40 | typed exactly 40/40 |
| unfocused, same apps | took over, then failed 40/40 | took over, typed exactly 40/40 |

The takeover itself is unchanged; that is #18784's ground.

Receiver stopped (`SIGSTOP`) for 2 s while omp types, then resumed; goliath Xvfb, 10 tries per cell, received text versus sent:

| Text (112 / 110 characters) | Receiver | Earlier head of this PR (typed in 4 runs) | This PR |
|---|---|---|---|
| `héllo wörld ✓ ` ×8, 4 keysyms outside the layout | Xlib, GTK 3 | not run (one run, as here) | exact 10/10 each |
| Russian pangram ×2, 33 keysyms outside the layout | Xlib | 33 of 110 characters wrong, 10/10 | refused before any key, 10/10 |
| same | GTK 3 | 33 of 110 characters wrong, 10/10 | refused before any key, 10/10 |

Another client's worst `GetInputFocus` round trip while omp binds a long text in one run, before and after the grab change (goliath Xvfb, optimized test build, one run per cell):

| `héllo wörld ✓ ` repeated | Before: split / bind | After: bind |
|---|---|---|
| 10,010 characters | 1.3 / 1.3 ms | 0.2 ms |
| 100,002 characters | 15.6 / 14.2 ms | 0.2 ms |
| 1,000,006 characters | 94.6 / 91.1 ms | 0.2 ms |

- `cargo test -p pi-natives --lib -- --ignored remap_tests` on goliath Xvfb: 10 passed, covering late-reading receivers through XTEST and `XSendEvent`, the over-capacity refusal, cancellation, foreign and rejected rebinds, refused chords, `MappingNotify` batching, MPX restore and failed close. The rejected-rebind test and `closing_a_session_reports_what_its_backend_could_not_undo` fail with their fix reverted.
- `a_cancel_stops_presses_but_never_releases` also checks MPX press counting around a cancel and a failed sync.
- Non-ignored `desktop::` tests pass; ignored `desktop::linux::x11` tests pass under Xvfb except four MPX tests needing Xorg with uinput hotplug (not run; the first-use MPX refusal is checked by reading). `scripts/rust-check` on Linux, macOS and Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
