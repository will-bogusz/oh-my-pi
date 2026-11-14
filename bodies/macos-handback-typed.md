## What

When another program types for you on macOS (a text expander, an automation or remote-control tool, another agent posting keystrokes) while omp's `computer` tool takes over the screen, the takeover put your app back in front with no key window: the window looked inactive and a web page in it was blurred until you clicked or pressed ⌘-Tab. Your keys still arrived. Typing on the keyboard yourself was not affected.

The takeover's input monitor reads only hardware keys and omp's own, by design, while `WindowServer` counts every key posted to the HID event tap. While another process posts keys the monitor never catches up with that count, so the hand-back read "a choice may still be on its way" and sent nothing, after it had already brought the app forward.

Now, only in that state, the window that was key is made key again unless a choice shows without the monitor: one it has already read, a click on the HID press counters, a held ⌘ or ⌃, or another of the app's windows focused. The request is the conditional one the background guard uses for its ⌘-Tab race, so `WindowServer` refuses it after any later click or key, and each try is checked again right before it goes; another app in front stops it too. When the monitor has caught up, nothing changes.

## Why

#19208 made the hand-back put the key window back; this is the one path where it still left none. Measured in a macOS 26.5 VM, base #19208 against this branch, 10 tries per cell and build, the user's app's own log as truth (Chrome: `document.hasFocus()` in the page):

| Keys posted by another process during the takeover | key window back, base | this PR |
|---|---|---|
| fast typing, user's app with two windows / one window | 0/10, 0/10 | 10/10, 10/10 |
| slow typing (150 ms) | 0/10 | 10/10 |
| one key, two windows / one window | 7/10, 9/10 | 10/10, 10/10 |
| Chrome with a focused field | 0/10 | 10/10 |

Unchanged on both builds: nine real-keyboard cells (fast, slow, one key; two windows, one window, Chrome) handed back 10/10; a click on the user's other window kept 10/10 with real or posted typing; ⌘-Tab to a third app kept 10/10; the guard's ⌘-Tab race pulled back 1/10; the five takeover cells of #19208 identical; 0 keys in the other window; call time within 10 ms. The rekey costs 0.06 ms median, 2.4 ms max.

<details><summary>Limits</summary>

- With posted typing, a ⌘-Tab during the hand-back ends on the user's own app in 9 of 10 tries on both builds, with identical end states (30 paired tries): that is the base's front request, unchanged here.
- A choice another process posts that leaves no trace (no press, ⌘ released before the check, same window focused) inside the ~50 ms the monitor is waited for would be overridden; not seen in 30 posted-choice tries.
- A real ⌘-` within a few ms of the hand-back is lost on both builds (2/40 each, never on this PR's path): #19208's own guard, tracked separately.
- `WindowServer` never refused a rekey in these runs, so the retry (at most three requests) did not run in the VM; unit tests cover it.

</details>

## Verification

Unit tests cover each branch of the hand-back's Pending case and the retry/stand-down loop (`rekey_unless_chosen`); both fail with the old "send nothing" restored. `cargo test -p pi-natives --lib -- skylight`.
