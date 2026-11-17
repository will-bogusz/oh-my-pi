## What

When a tool was typing for me (a text expander, an automation script, another agent posting keystrokes) while an omp `computer` call ran in takeover on macOS, my app came back to the front with no key window: a grey title bar, and the page I was in saw a blur until I clicked or pressed ⌘-Tab. The keys still arrived, and typing on the real keyboard was never affected.

The takeover's input monitor reads only hardware keys and omp's own, by design, but `WindowServer` counts every key posted to the HID event tap. While another process posts keys the monitor never catches up, so the hand-back read "a choice of the user's may still be on its way" and sent nothing, after it had already brought the app forward.

Now, only while the monitor is behind, the window that was key is made key again unless a choice shows without the monitor. The request is the conditional one #19208's guard uses for its ⌘-Tab race, so `WindowServer` refuses it after any later click or key; each try is checked right before it goes, and a refusal with nothing else showing is asked again, at most three requests. When the monitor has caught up, nothing changes.

| While the monitor is behind | What is sent | Notice |
|---|---|---|
| No choice shows | make-key records, then the window is confirmed key | `handed the keyboard back to Notes's window` |
| A shortcut the monitor counted, a click on the HID press counters, ⌘ or ⌃ down as a request is about to go, or another of the app's windows focused | nothing | `focus is on Notes, left as the user chose` |
| `WindowServer` refused three times, or another app is in front | nothing | as on `main` for `notSent` |
| Records sent, but the window is not confirmed key within 400 ms | nothing more: the records are sent once and the tool does not rerun the call | the call fails: `input may already have been delivered, but restoration failed: …; inspect the desktop before retrying` (after `UserIntervened`: that error, then `restoration also failed: …`). On `main` this call returned success with `notSent` |

The added work runs under the input lock: about 1 ms in the measured calls (median 0.9 ms, max 43 ms over 145), and at most about 1.4 s, from one 0.5 s accessibility read of the focused window plus the 400 ms confirm, whose last read can take another 0.5 s.

## Why

#19208 made the hand-back put the key window back; this was the one path where it still left none. Related: #19208.

## Testing

`cargo test -p pi-natives --lib -- skylight`: tests cover each outcome of that case and the retry and stand-down loop (`rekey_unless_chosen`); both new tests fail with the Pending branch reverted to `main`'s "send nothing", and the retry test fails with the retry removed.

Measured in a macOS 26.5 VM, `main` (#19208) against this branch, 10 tries per cell and build, with the user's app's own log as truth (Chrome: `document.hasFocus()` in the page). Keys from another process were posted to the HID event tap; real-keyboard keys and choices came through the VM's VNC server.

| Keys posted by another process during the takeover | Key window back at 0.5 s and 2 s, `main` → PR |
|---|---|
| Fast typing, user's app with two windows / one window | 0/10, 0/10 → 10/10, 10/10 |
| Slow typing (150 ms), one window | 0/10 → 10/10 |
| One key, two windows / one window | 7/10, 9/10 → 10/10, 10/10 |
| Chrome with a focused field, fast typing | 0/10 → 10/10 |

| Unchanged, `main` and PR alike | Result |
|---|---|
| Real-keyboard typing: fast, slow and one key; two windows, one window, Chrome (9 cells) | handed back 10/10 each |
| #19208's five takeover cells (type1, type2, chrome1, a click on the other window, a switch to a third app) | identical: handed back 10/10, the clicked window and the third app kept 10/10 |
| The guard's ⌘-Tab race | pulled back 1/10 on both |
| Keys landing in the user's other window | 0 in every cell |
| Call time | within 10 ms |

| A choice during the takeover | Choice kept, `main` / PR |
|---|---|
| Click on the other window, real or posted, with real or posted typing (3 cells) | 10/10 / 10/10 each |
| ⌘-Tab to a third app, real typing | 10/10 / 10/10 |
| ⌘-Tab, posted typing (real and posted ⌘-Tab) | 1/10 / 1/10 and 0/10 / 0/10, identical end states in 30 paired tries |
| ⌘-` to the other window, real typing | 38/40 / 38/40 |
| ⌘-` to the other window, posted typing (real and posted ⌘-`) | 0/10 / 1/10 and 0/10 / 6/10 |

In no try did the records undo a choice that had taken effect.

<details><summary>Limits</summary>

| Case | Count | Behaviour |
|---|---|---|
| ⌘-Tab during the hand-back with posted typing | ends on the user's own app 9/10 (real ⌘-Tab) and 10/10 (posted) on both builds | `main`'s front request lands while the switcher is open; unchanged here |
| ⌘-` with posted typing on `main` | 0/10 kept | ⌘-` does nothing in an app with no key window; this PR keeps 1/10 (real) and 6/10 (posted) |
| Real ⌘-` during the takeover, real typing | lost or overridden 2/40 on both builds; none of the 4 reached this PR's path | #19208's own hand-back, tracked separately |
| A choice another process posts that leaves no trace (no press, ⌘ released before the check, the same window focused) within the ~50 ms the monitor is waited for | 0 of 30 posted-choice tries | it would be overridden |
| ⌘ or ⌃ down as a request is about to go, held by the user or posted by a tool (a text expander's ⌘V) | posted ⌘ stood the request down in 7 of 20 posted ⌘-Tab and ⌘-` tries | nothing is sent and the notice says `left as the user chose`, though a tool's ⌘V picks nothing; the app stays without a key window, as on `main` |
| `WindowServer` without the conditional request (`SLSSetFrontProcessWithInfo` unresolved) | not met on 26.5 | the make-key records go out unconditionally after the same checks, as #19208's front request does there |
| `WindowServer` refusing a rekey | 0 in 145 Pending-path calls | the retry ran only in unit tests |
| Window not confirmed key after the records | 0 in 145 | the failing outcome above |
| macOS versions | 26.5 only | older macOS not run |

</details>
