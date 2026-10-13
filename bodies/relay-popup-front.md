## What

When omp clicked something in its relay tab that opened a popup while I was typing in another app, Chrome jumped to the front and the rest of what I typed went into the popup's page; now the relay puts my app back within a few milliseconds and my typing stays where it was.

| user typing in another app, omp's relay tab opens a popup (macOS) | #15590 | this PR |
|---|---|---|
| user's app in front afterwards | 0/31 | 30/30 |
| keys typed into the popup's page, of 150 | median 127 | 0 |
| Chrome in front | until the user switches back | 2-8 ms, when seen at all |

Reading order: `macos/skylight.rs` (`FrontHold`, `FrontApp::keep_in_front`) → `desktop/front_app.rs` → `relay/bridge.ts` (`#forwardToTab`, `#keepFrontApp`) → `relay/server.ts`.

## Why

On macOS Chrome makes itself the active app whenever it shows a tab or window a page opened, 35-55 ms after the click, even from a background tab, and keeps it. Neither the extension nor CDP can stop it (`chrome.windows.update(id, {focused: false})` never hands the app back); #15590 named this as its known limit. The relay runs on the user's Mac, so it hands the front back itself, through the WindowServer calls the computer tool already uses.

- **Read at omp's input, not at the popup report.** Chrome's report reaches the relay only 2-4 ms before Chrome is in front, so the relay reads the front app as it forwards omp's input to a tab, and uses it once, for a popup from that tab within a second.
- **Only the app that took the front goes back, for 500 ms.** A click, a held ⌘/⌃, or another app coming forward ends the hold, since that is the user picking an app; typing does not. The computer tool's guard on `main` stops at the first key press, which would leave exactly this user's keys in Chrome. The hold steps aside while the computer tool owns the desktop.
<details><summary>Rejected options, maintenance, not covered</summary>

- **Rejected:** holding after every input, popup or not, which would undo a launcher switch made right after omp's click; and waiting for #15195's rework of the computer tool's guard.
- **Maintenance:** `_SLPSGetFrontProcess` and `_SLPSSetFrontProcessWithOptions` are private SkyLight calls the computer tool already resolves. If macOS drops them, `macOSFrontApp()` returns null and the relay behaves as on #15590.
- **Not covered:** Linux and Windows (not measured), popups a page opens later on its own, and an app switch bound to a key without a modifier, made in the ~15 ms between omp's click and the report.

</details>

## Testing

Live: macOS 26.5 VM, Google Chrome 155 with the relay extension and the relay started as `omp browser-relay`; TextEdit in front receiving 150 hardware keystrokes 10 ms apart; omp clicks in its background relay tab 300 ms in.

| | #15590 (1bfc434771) | this PR |
|---|---|---|
| `_blank` link: TextEdit in front after / keys in the page | 0/11 / 125-130 | 10/10 / 0 |
| `window.open(url)` | 0/10 / 127-130 | 10/10 / 0 |
| sized `window.open` popup | 0/10 / 123-127 | 10/10 / 0 |
| plain click, no click: front changes | | 0/20 |
| user clicks their Chrome window 170 ms in: Chrome stays in front | | 10/10 |
| every key typed with Shift, popup rows: TextEdit in front after / keys in the page | | 15/15 / 0 |

One of 150 keys, typed in the few ms Chrome was in front, reached neither app in 5 of 45 popup trials. The rows above the Shift row ran on a build before the native export's rename and the Shift rule; the Shift row ran on the head.

<details><summary>Regression tests</summary>

- `browser-relay-bridge.test.ts`: a popup from the tab omp's input reached holds the app read at that input, once, and two popups from one click share the hold; nothing without input, after a second, or for input to another of omp's tabs. The first fails with the bridge change reverted, the other-tab case with a relay-wide read.
- `skylight.rs`: Shift while typing keeps the hold, a third app ends it; a click, ⌘, ⌃, or ⌥ before Chrome comes forward ends it; an app already in front at the first reading goes back unless ⌘/⌃/⌥ was held at the read or 50 ms passed with a modifier change, so a Shift just before it does not end the hold (roboomp's order).
- `control.rs`: the hold is busy while a computer task owns the desktop.

</details>

- `bun test test/tools/browser-relay-bridge.test.ts`, `bun run check:ts`, `CI=1 bun run check:rs` (on macOS) and `cargo nextest run -p pi-natives -E 'test(/skylight|control/)'` pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)




