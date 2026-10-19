## What

Even with my app put back in front, a key or two I typed in the few milliseconds Chrome held the front for omp's popup just vanished; now omp catches those keys and sends them to my app.

Popup trials that lost a key went from 10 of 30 on `main` to 0 of 30 (11 → 0 typing with Shift) on a macOS VM: every key reached TextEdit, in order, none twice and none in Chrome.

|omp's click in its relay tab opens a popup while the user types 150 keys into TextEdit|`main`|this PR|
|---|---|---|
|trials that lost a key|10/30|0/30|
|same, typing with Shift|11/30 (2 keys reached the popup's page)|0/30|
|keys macOS sent to Chrome while it was in front|21, none reached TextEdit|15, all reached TextEdit|

**Cost:** it needs the Accessibility permission the computer tool already needs; without it, or while secure text entry is on, the relay behaves as `main` does. omp's click took a median 65 ms against 60.5 ms (40 clicks each), and the first click of an omp process 32-35 ms longer (one run each) while the key tap is set up.

Reading order: `skylight.rs` (`front_app`, `PickLog::rearm`, `keep_in_front`) → `key_reroute.rs` → `process.rs` (`loopback_peer_app`) → `front_app.rs` → `bridge.ts` → `server.ts`.

## Why

Chrome takes the front for the popup until the relay hands it back 2-13 ms later. Logged routing shows every lost key went to Chrome's process in that gap.

- **The computer tool's key reroute moves them** back to the user's app. The relay finds Chrome as the app holding the other end of the extension's loopback socket.
- **Armed at omp's input, before Chrome activates**, by the relay's front-app read; the popup's hold carries it on. Armed at the hold instead, an omp process's first popup still lost keys (1 of 30 trials, Shift too): setting up the tap outlasted Chrome's activation.
- **One reroute per burst of input.** A click, a held ⌘/⌃ or an app picked from Spotlight or a launcher is the user choosing Chrome: those keys stay. None is armed while a computer action owns the desktop.
- **Rejected: opening popups from omp's tabs as background tabs.** Chrome stayed back (20 of 20 trials), but `window.opener` breaks, which OAuth sign-in popups need; doing it only for links and `noopener` opens is a possible later step.
- **Maintenance:** if the socket lookup (public `libproc`) finds nothing, the relay behaves as `main`. A computer action starting just as the relay reads can fail as busy.

## Testing

Live: macOS 26.5 VM, Chrome 155.0.8059.80. 150 keys 10 ms apart go into TextEdit through the VM's VNC keyboard (hardware keys to macOS); omp clicks in its background relay tab 300 ms in. `main` ran at 17473d8eb3 (the change that hands the front back); this PR's natives were built one `const fn` earlier.

<details><summary>Per popup kind (10 trials each)</summary>

|trials that lost a key|`main`|`main`, Shift|this PR|this PR, Shift|
|---|---|---|---|---|
|`_blank` link|4|3|0|0|
|`window.open(url)`|3|4|0|0|
|sized `window.open` popup|3|4|0|0|
|plain click, no popup|0|-|0|-|

</details>

- `browser-relay-bridge.test.ts`: the opening tab's browser reaches the read and the hold (fails with `main`'s `bridge.ts`); a lookup outlived by its connection is ignored. `process.rs`: the loopback peer is found, never omp. `key_reroute.rs`: when a reroute stands in for a new one.
- macOS: `cargo test -p pi-natives --lib` (913 pass), `CI=1 bun run check:rs`, `CI=1 bun check`; bridge tests 82 pass.

Not run: no Accessibility or secure entry on (no tap is made), a physical keyboard, the user clicking into Chrome within the second (the reroute's tests cover it).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
