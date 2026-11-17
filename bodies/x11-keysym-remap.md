## What

I made X11 typing put in characters the keyboard layout has no key for, like é, ö, ✓ or a Russian sentence on a US layout, because every such `type()` failed with "X11 keymap has no keycode for keysym 0xe9".

Typing `héllo wörld ✓` into a GTK 3, Qt 5, Qt 6 or Chromium field: refused 40 of 40 times on `main`, typed exactly 40 of 40 with this PR.

## Why

X11 typing presses keys, so `Keymap::plan_text` (`linux/x11/keymap.rs`) refused a whole text when one character had no keycode. xdotool's answer is to bind the missing keysym to an unused keycode and restore it later; `TextMapping` (`linux/x11/text_mapping.rs`) does that. Bindings stay for the session and are restored when it closes. The X server grab covers only keymap reads and writes: another X client now waits under 2 ms however long the text, where splitting a million characters under the grab stalled it 95 ms (table below).

Limits:

- Chords and holds of such characters still refuse, as on `main`. If omp is killed, the bound rows stay until `setxkbmap` reloads the layout; the no-free-row refusal says so.
- A text needing more rows than are free is typed in runs, and a run that evicts a binding whose key went out less than 500 ms ago waits out the rest first. The wait keeps the cross-session input lease, so another session's keys cannot land inside the text, and in takeover, after the first run, the target's focus. On Xvfb's default layout (19 free rows), 550 Russian characters took 9.5 s in 20 runs, against 22 ms for 560 characters in one run.

<details><summary>Binding rules</summary>

- An app translates a key against the keymap when it reads the event, so a row restored right after the key can be read empty: a receiver that read its keys only after the call lost characters when each run restored its rows. A row is rebound only 500 ms after its last key went out, also when an earlier call in the session used it, so a first run can wait too.
- Only empty, non-modifier rows are taken, least recently used bindings evicted first. Ownership checks and writes run under `GrabServer`; the text is split from a snapshot after the grab ends, and each run's distinct keysyms are collected before its own grab, which re-reads the keymap before writing. A restore clears only rows that still hold our keysym, so another client's binding survives.
- The first run is bound before takeover activates the window, so a text whose first run cannot be bound moves no focus. Later runs are bound inside the takeover; a refusal there says part of the text was sent.
- XTEST and `XSendEvent` bind through the core keyboard; MPX keyboards bind on their own device and its master. Element-takeover chords now plan on the XTEST device's keymap (`Keymap::xtest`), as text already did.

</details>

## Testing

Capability-matrix cell `type("héllo wörld")` after a click on the field, Ubuntu 22.04 arm64 microVM (Xvfb, openbox, US layout), real eval path, n=10 per cell, field text as truth, run at `509c34a737e` before the rebase onto current main:

| Window | `main` | This PR |
|---|---|---|
| focused (GTK 3, Qt 5, Qt 6, Chromium 156) | refused 40/40 | typed exactly 40/40 |
| unfocused, same apps | took over, then failed 40/40 | took over, typed exactly 40/40 |

The takeover itself (focus moved while the user works) is unchanged; that is #18784's ground.

Another client's worst `GetInputFocus` round trip while omp splits and binds a long text, before and after the grab change (goliath Xvfb, 19 free rows, optimized test build, one run per cell):

| Text | Characters | Runs | Before: split / bind | After: split / bind |
|---|---|---|---|---|
| `héllo wörld ✓ ` repeated | 10,010 | 1 | 1.3 / 1.3 ms | 0.1 / 0.2 ms |
| same | 100,002 | 1 | 15.6 / 14.2 ms | 0.1 / 0.2 ms |
| same | 1,000,006 | 1 | 94.6 / 91.1 ms | 0.1 / 0.2 ms |
| Russian pangram repeated | 10,010 | 364 | 2.8 / 3.5 ms | 0.1 / 0.6 ms |
| same | 100,045 | 3,638 | 32.4 / 8.6 ms | 0.1 / 1.6 ms |

- Nine ignored Xvfb tests (`--ignored remap`): exact receipt through XTEST and `XSendEvent`, a receiver that reads only after the send, a Russian pangram longer than the free rows, cancellation and unwind, a foreign rebind surviving our restore, no `FocusIn` on a refused chord, one `MappingNotify` per batch, MPX restore.
- `a_cancel_stops_presses_but_never_releases` also checks that an MPX press cancelled before its write counts nothing and one whose sync report fails counts.
- On goliath at `a382b7bb786` (this change on `bf9a9fbd40e`): the other ignored `desktop::linux::x11` tests pass under Xvfb except four MPX tests that need Xorg with uinput hotplug (not run on Xorg); non-ignored `desktop::linux::x11` 40 passed. Linux `rust-check` at this head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
