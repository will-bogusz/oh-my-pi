## What

I made X11 typing put in characters the keyboard layout has no key for, like é, ö, ✓ or a Russian word on a US layout, because every such `type()` failed with "X11 keymap has no keycode for keysym 0xe9".

Typing `héllo wörld ✓` into a GTK 3, Qt 5, Qt 6 or Chromium field: refused 40 of 40 times on `main`, typed exactly 40 of 40 with this PR.

## Why

X11 typing presses keys, so `Keymap::plan_text` refused a whole text when one character had no keycode. `TextMapping` (`linux/x11/text_mapping.rs`) binds the missing keysym to an unused keycode and restores it later, as xdotool does. Bindings are kept and reused, restored when the session closes; a later call may take a row over once its last key is 500 ms old. The server grab covers only keymap reads and writes: another X client waits under 2 ms however long the text (91 ms for a million characters before).

Several omp sessions can share a display's keymap, so each marks the rows it binds in a `_OMP_TEXT_KEYCODES` root-window property, under the grab it already takes. A mark names an unmapped window on the session's own X connection, not a pid: the server destroys it with the connection, so a dead session is told from a live one even when two share a process or pid namespace.

Limits:

- A text needing more distinct characters outside the layout than there are spare keycodes (19 on Xvfb's default US layout) is refused before any key, saying how many fit; typing it in runs garbled late-reading receivers (cells below).
- Chords and holds of such characters still refuse, as on `main`. If omp is killed, its rows stay bound until another session takes them or `setxkbmap` reloads the layout.
- A call needing a row an earlier call used under 500 ms ago waits out the rest before its first key, holding the cross-session input lease; a receiver stalled longer can read the earlier call's keys through the new keysym.
- While the core and `XTest` maps disagree on a row another live session marked (after a device switch), text and chords refuse with nothing sent until the layout settles or `setxkbmap` reloads it; a lone session never meets this.
- A session whose restore fails, or leaves a row the two maps disagree on, keeps its marks until its X connection closes.
- At most 1,024 marks are read; any past them are ignored.

<details><summary>Binding rules</summary>

- An app translates a key against the keymap when it reads the event, so a row restored right after the key can be read empty: a receiver that read its keys only after the call lost characters when each call restored its rows.
- Only empty, non-modifier rows are taken, least recently used bindings evicted first. Ownership checks and writes run under `GrabServer`; the text's distinct keysyms are collected before it. A rebind owns the row under its old and new keysym until the write and read-back succeed, so a rejected or partial write is still restored; a restore clears only rows holding one of our keysyms, so another client's binding survives.
- Binding happens before takeover activates the window, and before a fresh MPX keyboard's warm-up key, so a refused text moves no focus and sends no key. XTEST and `XSendEvent` bind through the core keyboard; MPX keyboards bind on their own device and its master. Element-takeover chords now plan on the XTEST device's keymap (`Keymap::xtest`), as text already did.
- A row another live session marked is never native, never used for chords, holds or held pointer keys, and never cleared: this session binds its own row for that keysym. A row whose owner window is gone may be taken. A row a layout reload (`setxkbmap`) cleared is bound again. A core write also rewrites the `XTest` keyboard, so a row is taken only if empty in both maps, and a restore writes no row the two maps disagree on, whoever owns it. Only core-map rows are marked; an MPX keyboard's map is its pair's own.
- Session close (`DesktopSession.close()`) now returns a restore failure instead of dropping it.

</details>

## Testing

Capability-matrix cell `type("héllo wörld")` after a click on the field, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, US layout), real eval path, n=10 per cell, field text as truth, at `509c34a737e` before the rebase:

| Window | `main` | This PR |
|---|---|---|
| focused (GTK 3, Qt 5, Qt 6, Chromium 156) | refused 40/40 | typed exactly 40/40 |
| unfocused, same apps | took over, then failed 40/40 | took over, typed exactly 40/40 |

The takeover itself is unchanged; that is #18784's ground.

Receiver stopped (`SIGSTOP`) for 2 s while omp types; goliath Xvfb, 10 tries per cell, received versus sent:

| Text (112 / 110 characters) | Receiver | Earlier head of this PR (typed in 4 runs) | This PR |
|---|---|---|---|
| `héllo wörld ✓ ` ×8, 4 keysyms outside the layout | Xlib, GTK 3 | not run (one run, as here) | exact 10/10 each |
| Russian pangram ×2, 33 keysyms outside the layout | Xlib | 33 of 110 characters wrong, 10/10 | refused before any key, 10/10 |
| same | GTK 3 | 33 of 110 characters wrong, 10/10 | refused before any key, 10/10 |

Another client's worst `GetInputFocus` round trip while omp binds a long text (goliath Xvfb, optimized build, one run per cell):

| `héllo wörld ✓ ` repeated | Before: split / bind | After: bind |
|---|---|---|
| 10,010 characters | 1.3 / 1.3 ms | 0.2 ms |
| 100,002 characters | 15.6 / 14.2 ms | 0.2 ms |
| 1,000,006 characters | 94.6 / 91.1 ms | 0.2 ms |

Two native `DesktopSession`s typing into one Xlib window (goliath Xvfb, 2 runs per head): A types ✓, its grace passes, B chords and types ✓, A closes:

| | `11100c5f055` | This head |
|---|---|---|
| B's `keyChord(["✓"])` while A's row is bound | accepted, 2/2 | refused, 2/2 |
| B's keys read after A closed | NoSymbol, 2/2 | B's own row's ✓, 2/2 |

<details><summary>Checks</summary>

- `cargo test -p omp-natives --lib -- --ignored remap_tests` on goliath Xvfb: 14 passed. They cover late-reading receivers through XTEST and `XSendEvent`, the over-capacity refusal, cancellation, foreign rebinds, a layout reload, refused chords, `MappingNotify` batching, MPX restore and failed close. They also cover two sessions: B neither chords nor types through A's row; A's restore leaves the row B took after a reload; a dead session's mark does not hide a row this session holds; and with split core and `XTest` maps, B's bind over A's `XTest` row, A's bind and chord over B's row are refused with no row written, A's restore leaves B's `XTest` row and keeps its own marked, and a `setxkbmap` reload ends the refusal. The first two-session test fails on `11100c5f055`, the split test on `d0ab2f333f0` (B's bind succeeds instead of refusing), the split test's last step and the dead-mark test on an earlier draft of this commit. `closing_a_session_reports_what_its_backend_could_not_undo` fails with its fix reverted.
- One session, no stall: `héllo wörld ✓`, `да выпей чаю, мир` and `café naïve ß œuvre €` typed 10 times each into an Xlib and a GTK 3 receiver on goliath Xvfb, `setxkbmap` reload before the sixth: exact 30/30 per receiver, no refusal.
- Unit tests: a rebound row stays ours under its old and new keysym until the write is confirmed, eviction keeps a text's symbols, and a restore leaves a row the core and `XTest` maps disagree on even when a failed rebind owns it under both keysyms (fails with the previous restore rule). `a_cancel_stops_presses_but_never_releases` checks MPX press counting around a cancel and a failed sync.
- Non-ignored `desktop::` tests pass. Ignored `desktop::linux::x11` tests pass under Xvfb except four MPX tests that need Xorg with uinput hotplug: they fail under Xvfb and were not run on Xorg, so the first-use MPX refusal is checked by reading only. The same results hold on the tree merged with #19531. `scripts/rust-check` on Linux, macOS and Windows at this head.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


