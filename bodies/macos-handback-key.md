## What

After a macOS `computer` call that ran in takeover, or a background call whose target app brought itself to the front, my app came back to the front with its window inactive: a grey title bar, and a web page in it saw a `blur` and reported `document.hasFocus()` false until I clicked it. The takeover notice said "focus returned". Now the window that was key is key again, and the notice says what was done with my keyboard.

Both paths put the user's app back with a `kCPSNoWindows` front request, which activates the app without installing any key window. The takeover skipped its make-key records whenever the app's `AXFocusedWindow` named the user's window, which AppKit does even when no window is key; the background focus guard sent a single focus record that does not make a window key. Both now send the make-key records the takeover already uses to enter the target.

Where the user's app never left the front (the takeover's target was another of its own windows), the old accessibility check stays, so an already-key Chromium window is not re-keyed; re-keying one can clear its renderer focus. A click, shortcut or switch of the user's still wins: no records are sent over it. When the guard finds nothing stolen it sends nothing, as before.

| What the takeover did | Notice on macOS |
|---|---|
| Records sent to the user's window | `handed the keyboard back to Notes's window` |
| The user clicked, used a shortcut or switched meanwhile | `focus is on Notes, left as the user chose` |
| The user's last input was still being read | `handed the front back to Notes but not its window's keyboard: …`, or `focus is on Notes; … so nothing was sent to its window` when macOS refused the hand-back |
| A record was rejected | the call fails with `restoration failed: window N rejected its make-key record` (unchanged) |

The same reading is exposed to hosts as `DesktopFocusReturn.keyboard`.

## Why

Nothing outside the app can tell its key window from that fallback answer. On a macOS 26.5 VM I compared every accessibility attribute of the app, its windows and its focused element, plus `WindowServer`'s front and key-focus process and window tags, with the window key and not key: all identical. So the decision rests on what the hand-back's own request does, measured below, and the notice names what was sent rather than a key state it cannot see.

## Testing

Real addons, `main` against this branch interleaved, 10 tries each on one macOS 26.5 VM. The user's app logs its own `isKeyWindow` (for Chrome, the page's `hasFocus()` and focused field), and a simulated user types 20 keys into it during or right after the call.

| User's app ← call | Window key again within 0.5 s, `main` → PR | call ms, `main` → PR |
|---|---|---|
| AppKit app, one window ← takeover typing into TextEdit | 0/10 → 10/10 | 371 → 382 |
| AppKit app, two windows, the second key ← same | 0/10 → 10/10, the second | 369 → 374 |
| AppKit app ← takeover into Chrome's address field | 0/10 → 10/10 | 357 → 359 |
| AppKit app ← takeover into a LibreOffice Calc cell | 0/10 → 10/10 | 388 → 392 |
| Chrome page with a focused field ← takeover typing into TextEdit | 0/10 → 10/10 | 346 → 349 |
| AppKit app ← background click into an app that activates itself | 0/20 → 20/20 | 668 → 670 |

The simulated user's keys arrived on both builds in every takeover cell (an inactive window still takes them), so what changes is the window being drawn and reported as focused. With Chrome as the user's app and a background click that steals the front, the page never reported a blur on this branch (0 of 17 calls, against 7 of 14 on `main`) and its field kept focus with the caret after the last typed character. When the user clicked another of their windows during the call, or another app, that choice stood on both builds and nothing was sent over it.

Nothing moved where nothing was stolen: background click, typing and key calls into TextEdit while the user typed into a Chrome page field kept the page focused in 30 of 30 calls on both builds, at the same call time (656 → 658, 519 → 519, 541 → 540 ms). A 250-action run of background actions across six apps with a user typing throughout, including apps that come forward late, lost 0 of 3000 keys and left 0 apps in front on both builds (p50 534 → 533 ms).

`cargo test -p pi-natives --lib -- the_hand_back_makes_the_previous_window_key a_choice_during_the_call` covers the decision; the first fails on `main`'s rule (records skipped when the app names the window). The guard's record change has no unit seam: it is the bytes sent, measured above. The prompt edit swaps one example string for the new notice.

## Risk

Review first: `give_key_back` and `choice_baseline` in `skylight.rs`. Each hand-back from behind the target now sends one `kCPSUserGenerated` front request for the user's own app that `main` sent only when the accessibility answer disagreed; it is skipped when the user acted after the hand-back. The "no key window after `kCPSNoWindows`" behaviour was measured on macOS 26.5 only.
