## What

When omp clicked something in its relay tab that opened a popup while I was typing in another app, Chrome jumped to the front and the rest of what I typed went into the popup's page; now the relay puts my app back within a few milliseconds and my typing stays where it was.

In 31 trials on `main` Chrome kept the front every time and a median of 127 of 150 keystrokes went into its page; with this PR the user's app was back in front in 30 of 30, within 2-13 ms, and 1 keystroke in total reached Chrome.

Known limit: a key typed in those 2-13 ms can still be lost: 12 of the 30 trials lost one or two (13 in all), and only one of those reached Chrome's page. On `main` each popup cost a median of 127 keys, all into Chrome.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/819e373b-af3e-4224-ae39-9778420a548e">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/e1ff3ac2-1e98-4432-9141-05d0f51ee212">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/92dd5309-6f61-4f0d-8199-62be2863c884">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/cf843ee2-8d6d-449d-8d86-5694c1fe4a0c">
  <img width="780" alt="Every trial as a dot. When omp's click in its relay tab opens a popup while the user types in TextEdit, Chrome keeps the front on main in 31 of 31 trials and a median 127 of 150 keystrokes reach its page; with this PR TextEdit is back in front in 30 of 30 trials, within 2–13 ms, and 1 keystroke in total reaches Chrome." src="https://github.com/user-attachments/assets/e1ff3ac2-1e98-4432-9141-05d0f51ee212" />
</picture>

<details><summary>Exact numbers (31 trials on main, 30 with this PR)</summary>

|popup opened by omp's click in its relay tab (macOS)|`main`|this PR|
|---|---|---|
|`_blank` link: user's app in front after / keys reaching Chrome's page, of 150|0/11 / 124-127|10/10 / 0|
|`window.open(url)`|0/10 / 127-129|10/10 / 0-1|
|sized `window.open` popup|0/10 / 123-129|10/10 / 0|
|Chrome in front|until the user switches back|2-7, 3-13 and 3-8 ms|

</details>

Reading order: `macos/skylight.rs` (`FrontHold`, `PickLog`, `hold_front`) → `desktop/front_app.rs` → `relay/bridge.ts` (`#forwardToTab`, `#onCdpEvent`, `#keepFrontApp`) → `relay/server.ts`.

## Why

On macOS Chrome makes itself the active app whenever it shows a tab or window a page opened, even from a background tab, and keeps it. Neither the extension nor CDP can stop it (`chrome.windows.update(id, {focused: false})` never hands the app back). The relay runs on the user's Mac, so it hands the front back itself, through the WindowServer calls the computer tool already uses.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/bb35d635-aa01-4963-8392-17f2bf26ad53">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/c59051a7-4065-4d70-a4d8-e03b17bacf01">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/c6e7a49c-9398-4f9b-98da-b9a2a3d3e15c">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/255a4dcc-cb58-4e9e-ae2c-2dbb9a255471">
  <img width="780" alt="Timeline, main against this PR. omp's click reaches its background relay tab; with this PR the relay reads the app in front as it forwards the click. The page opens a window (Page.windowOpen, 6-14 ms later), which starts a 500 ms hold. When Chrome makes itself the active app (36-87 ms after the click), main leaves Chrome in front so the user's next keys go to its page; this PR puts the user's app back within 2-13 ms. A click, a held Command or Control key, or picking an app ends the hold." src="https://github.com/user-attachments/assets/c59051a7-4065-4d70-a4d8-e03b17bacf01" />
</picture>

- **Read at omp's input, hold on `Page.windowOpen`.** The relay reads the front app as it forwards omp's `Input.*` to a tab. When that tab's page (or a frame in it) emits `Page.windowOpen` within a second, the relay uses that reading once. Chrome sends this CDP event 6-14 ms after the click, 19-46 ms before the new target exists. It reaches the relay through the debugger session it already holds, so the extension and its protocol do not change.

- **Only the app that took the front goes back, for 500 ms.** Typing, Shift included, does not end the hold. A click, a held ⌘/⌃, another app coming forward, or an app picked from Spotlight or a launcher panel does, because that is the user picking an app. From the reading at omp's input until the hold starts, a sampler logs ⌘/⌃ and panels, so a ⌘-Tab made in between also counts. Each hand-back goes through the timestamped request `main`'s background guard uses, so a click that lands just before it makes WindowServer refuse it. The hold steps aside while the computer tool owns the desktop.

<details><summary>Rejected options, maintenance, not covered</summary>

- **Rejected:** holding after every input, popup or not, which would undo a launcher switch made right after omp's click; and running `with_background_watch` around the input, which reads the user's key window over AX (an Accessibility grant the relay process may not have) and starts from whatever app is in front at the popup, not at omp's input.
- **Maintenance:** `_SLPSGetFrontProcess`, `SLPSGetKeyFocusProcess` and the conditional `SLSSetFrontProcessWithInfo` are private SkyLight calls the computer tool already resolves. If macOS drops them, `macOSFrontApp()` returns null (or the hand-back goes unconditional) and the relay behaves as before.
- **Not covered:** Linux and Windows (not measured), a window a page opens more than a second after omp's input, and an app switch bound to a key with no modifier.
</details>

## Testing

Live: macOS 26.5 VM, Google Chrome 155.0.8059.80 with the relay extension each tree installs (`omp browser-relay install`) and the relay started as `omp browser-relay`. TextEdit is in front receiving 150 hardware keystrokes 10 ms apart; omp clicks in its background relay tab 300 ms in. `main` ran at 1a97f79d28, this PR at c4781ccb92 (the head's code before a test-file reformat and a docs move).

||this PR|
|---|---|
|Chrome seen in front during the popup trials|29/30|
|plain click, no click: front-app changes|0/20|
|every key typed with Shift, all three popups: TextEdit in front after / keys reaching Chrome / trials that lost a key|15/15 / 0 / 3|

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
