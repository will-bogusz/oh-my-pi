## What

When omp clicked something in its relay tab that opened a popup while I was typing in another app, Chrome jumped to the front and the rest of what I typed went into the popup's page; now the relay puts my app back within a few milliseconds and my typing stays where it was.

|user typing in another app, omp's relay tab opens a popup (macOS)|`main`|this PR|
|---|---|---|
|user's app in front afterwards|0/31|30/30|
|keys typed into the popup's page, of 150|median 127|0 (1 in one trial)|
|Chrome in front|until the user switches back|2-13 ms|

Reading order: `macos/skylight.rs` (`FrontHold`, `PickLog`, `hold_front`) → `desktop/front_app.rs` → `relay/bridge.ts` (`#forwardToTab`, `#onCdpEvent`, `#keepFrontApp`) → `relay/server.ts`.

## Why

On macOS Chrome makes itself the active app whenever it shows a tab or window a page opened, 35-55 ms after the click, even from a background tab, and keeps it. Neither the extension nor CDP can stop it (`chrome.windows.update(id, {focused: false})` never hands the app back). The relay runs on the user's Mac, so it hands the front back itself, through the WindowServer calls the computer tool already uses.

- **Read at omp's input, hold on `Page.windowOpen`.** The relay reads the front app as it forwards omp's `Input.*` to a tab. When that tab's page (or a frame in it) emits `Page.windowOpen` within a second, the relay uses that reading once. Chrome sends this CDP event 6-14 ms after the click, 19-46 ms before the new target exists. It reaches the relay through the debugger session it already holds, so the extension and its protocol do not change.
- **Only the app that took the front goes back, for 500 ms.** Typing, Shift included, does not end the hold. A click, a held ⌘/⌃, another app coming forward, or an app picked from Spotlight or a launcher panel does, because that is the user picking an app. From the reading at omp's input until the hold starts, a sampler logs ⌘/⌃ and panels, so a ⌘-Tab made in between also counts. Each hand-back goes through the timestamped request `main`'s background guard uses, so a click that lands just before it makes WindowServer refuse it. The hold steps aside while the computer tool owns the desktop.
<details><summary>Rejected options, maintenance, not covered</summary>

- **Rejected:** holding after every input, popup or not, which would undo a launcher switch made right after omp's click; and running `with_background_watch` around the input, which reads the user's key window over AX (an Accessibility grant the relay process may not have) and starts from whatever app is in front at the popup, not at omp's input.
- **Maintenance:** `_SLPSGetFrontProcess`, `SLPSGetKeyFocusProcess` and the conditional `SLSSetFrontProcessWithInfo` are private SkyLight calls the computer tool already resolves. If macOS drops them, `macOSFrontApp()` returns null (or the hand-back goes unconditional) and the relay behaves as before.
- **Not covered:** Linux and Windows (not measured), a window a page opens more than a second after omp's input, and an app switch bound to a key with no modifier.
</details>

## Testing

Live: macOS 26.5 VM, Google Chrome 155.0.8059.80 with the relay extension each tree installs (`omp browser-relay install`) and the relay started as `omp browser-relay`. TextEdit is in front receiving 150 hardware keystrokes 10 ms apart; omp clicks in its background relay tab 300 ms in.

||`main` (1a97f79d28)|this PR|
|---|---|---|
|`_blank` link: TextEdit in front after / keys in the page|0/11 / 124-127|10/10 / 0|
|`window.open(url)`|0/10 / 127-129|10/10 / 0-1|
|sized `window.open` popup|0/10 / 123-129|10/10 / 0|
|Chrome seen in front / put back after||29/30 / 2-13 ms|
|plain click, no click: front changes||0/20|
|every key typed with Shift, popup rows: TextEdit in front after / keys in the page||15/15 / 0|

In 12 of the 30 popup trials one or two of the 150 keys, typed in the few ms Chrome was in front, did not reach TextEdit; one of them reached the page.

<details><summary>Regression tests</summary>

- `browser-relay-bridge.test.ts`: a `Page.windowOpen` from the tab omp's input reached holds the app read at that input, once; two windows from one click share the hold, and a frame's window reported on its own session counts. Nothing is held without input, after a second, or for input to another of omp's tabs. The first fails with `main`'s `bridge.ts`.
- `skylight.rs`: only the app that took the front goes back while the user types, and a third app ends the hold; a click, ⌘, ⌃, or ⌥ before a taker ends it; an app picked from a launcher panel (open at the read or during the hold) stays in front, while the browser taking the keyboard a moment early is no panel; an app already in front at the first reading goes back with only Shift typed since the read, and stays after a ⌘/⌃ in between; the pick log reports only what came after the read; a click between the last check and the hand-back leaves the browser in front, uncounted; a hand-back refused for typing is asked again. With the panel and ⌘/⌃ rule reverted to "any app already in front at the first reading stops the hold" and refused hand-backs counted, the launcher, first-reading, click-race and typing-retry tests fail.
- `control.rs`: the hold is busy while a computer task owns the desktop.
</details>

- On macOS: `cargo test -p pi-natives --lib` (902 pass), `cargo check -p pi-natives --tests`, `CI=1 bun run check:rs` and `CI=1 bun check` pass; `browser-relay-bridge.test.ts`: 79 pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
