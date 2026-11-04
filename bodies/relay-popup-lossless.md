## What

Even with my app put back in front, a key or two I typed in the few milliseconds Chrome held the front for omp's popup just vanished; now omp catches those keys and sends them to my app.

Popup trials that lost a key went from 10 of 30 on `main` to 0 of 30 (10 → 0 typing with Shift) on a macOS VM: every key reached TextEdit, in order, none twice and none in Chrome.

|omp's click in its relay tab opens a popup while the user types 150 keys into TextEdit|`main`|this PR|
|---|---|---|
|trials that lost a key|10/30|0/30|
|same, typing with Shift|10/30|0/30|
|keys macOS sent to Chrome while it was in front|20, none reached TextEdit|17, all reached TextEdit|

**Cost:** it needs the Accessibility permission the computer tool already uses; without it, or while secure text entry is on, the relay behaves as `main` does. omp's click took a median 76.5 ms against 71 ms (40 clicks each); the first click of an omp process takes about 35-40 ms longer (two runs each) while the key tap is set up.

**Opt-out:** `PI_BROWSER_RELAY_KEEP_FRONT=0`, which turns off the front-app hold, now turns off this reroute too: one switch stops everything that watches the user's input (no tap is set up; 10 of 10 trials behaved as `main`).

## Why

Chrome takes the front for the popup until the relay hands it back milliseconds later. Logged routing shows every lost key went to Chrome in that gap.

- **The computer tool's key reroute moves them** back to the user's app. The relay finds Chrome as the app holding the other end of the extension's loopback socket.
- **Set up at omp's input, before Chrome activates and before the relay's front-app read starts its watch**; the popup's hold extends that watch and never takes its reroute. Set up at the hold instead, an omp process's first popup still lost keys: setting up the tap (about 30 ms the first time) outlasted Chrome's activation.
- **One reroute per burst of input.** A click, a held ⌘/⌃ or an app picked from Spotlight or a launcher is the user choosing Chrome: those keys stay. None is set up while a computer action owns the desktop.
- **Rejected: background tabs for omp's popups.** Chrome stayed back (20/20), but `window.opener` breaks, which OAuth popups need.
- **Maintenance:** if the socket lookup (public `libproc`) finds nothing, the relay acts as `main`.
- **Concurrency limit:** a later reroute can supersede an earlier browser's protection; separate omp processes are not lifetime-coordinated.

## Testing

<details><summary>Per popup kind (10 trials each)</summary>

Live measurements: macOS 26.5.2 VM, Google Chrome 156.0.8078.80. 150 keys 10 ms apart go into TextEdit through the VM's VNC keyboard (hardware keys to macOS); omp clicks in its background relay tab 300 ms in. ABBA blocks on one guest, each a fresh omp process, relay and Chrome; `main` at ff0a986b88, this PR's head 2e4fe5626f on it.

|trials that lost a key|`main`|`main`, Shift|this PR|this PR, Shift|
|---|---|---|---|---|
|`_blank` link|3|3|0|0|
|`window.open(url)`|2|3|0|0|
|sized `window.open` popup|5|4|0|0|
|plain click, no popup|0|-|0|-|

The relay put the user's app back in front for all 15 popups of every block in both arms.

</details>

- Bridge tests: the opening tab's browser reaches the read before input; delayed lookup preserves key-down/key-up order, and a reconnect rejects stale input. Server test: with the switch at `0` the browser is never looked up (fails with the check removed). Rust: the loopback peer is found, never omp; a watch gap or pick replaces the reroute; a switch during setup re-arms for the final app; an older hold cannot consume a newer read's reroute.
- macOS: `cargo test -p pi-natives --lib` (900 pass); clippy and rustfmt on macOS, Linux and Windows; bridge and server tests on Linux: 101 pass, 1 macOS-only skip. All package `check:types` commands pass.

Not run: no Accessibility or secure entry on (no tap is made), a physical keyboard, the user clicking into Chrome within the second (tests cover it).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
