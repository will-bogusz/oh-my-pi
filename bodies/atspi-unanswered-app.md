## What

I gave Linux AT-SPI requests a 5 s limit and cancellation, and removed connections to every app, because one unresponsive app froze the computer tool for the rest of the session.

An Audacity dialog opened by `press()` or `menu.select()` now produces a `Timeout` after 5 s while screenshots and input remain usable, instead of blocking later calls until the 120 s run timeout.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/3eaf1da9-931b-48ef-820f-b01e42c7fbee">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/e60134a7-96a8-415a-80b3-a35970bbb93f">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/e87aa674-3b17-4fa4-91b5-24ed3eba9edc">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/f11c95c9-c5a1-42fc-908c-9fcffcc300ef">
  <img width="780" alt="Timeline, main against this PR, after press() on Audacity's Analyze > Label Sounds... opens a modal dialog. main: the press returns and the dialog ignores typed input, ax() waits forever because Audacity answers no AT-SPI call, screenshot and Escape queue behind it and each call ends at the 120 s run timeout for the rest of the session, and ax() never runs again. This PR: the press returns, ax() fails with Timeout after 5 s, naming Audacity, the screenshot and Escape run at once and Escape closes the dialog, and ax() reads the window again." src="https://github.com/user-attachments/assets/e60134a7-96a8-415a-80b3-a35970bbb93f" />
</picture>

## Why

AT-SPI requests occupied the sole desktop worker without a limit; cancellation could not interrupt them. Connecting peer-to-peer to every app also left Audacity's modal dialog ignoring typed input and could wedge the accessibility bus after idle client churn.

The limit is per request, not libatspi's 800 ms per call: a request makes multiple calls, and a LibreOffice edit takes 1.75 s. Menu walks bound each call instead. Window enumeration skips apps that do not answer; targeted reads report `Timeout`. A timed-out command may still run later, which its error says.

Not changed: clicking a closed menu's item can still fail with `InvalidCoordinateFrame`. The Audacity case has not been run on Wayland.

<details><summary>Reading order (crates/pi-natives/src/desktop/)</summary>

- `linux/ax.rs`: `REPLY_TIMEOUT`, `AtSpiAx::run` (cancellable wait), `request` (one limit for a request) and `reply` (one limit per call, for whole-app and menu reads), used by every `AxBackend` method and `linux/ax/menus.rs`.
- `linux/ax.rs` per-app enumerations: `windows`/`app_windows`, `app_for_window`, `element_at`/`frames_at`, `focused_element`/`find_focused`.
- `Backend::missing_window` and `wayland/mod.rs`: a Wayland window or focus lookup that misses an app `windows()` skipped fails with `Timeout`, not "not found".
- `linux/ax.rs` `AtSpiAx::new`: the bus address from `org.a11y.Bus`, no peer connections; `Cargo.toml` drops atspi's `connection`/`p2p` features (zbus `p2p` stays for the test fixtures only).
- `ax.rs` `walk_raw`: a `Timeout` or `Cancelled` ends the walk instead of being skipped node by node.
- `control.rs` `cancellable`: moved unchanged from `wayland/libei.rs`.

</details>

<details><summary>Idle-bus failure and measurement</summary>

Dropping the peer connections also stops an idle OMP from wedging itself and the accessibility bus. On `main`, atspi's peer listener subscribes OMP's bus connection to every `NameOwnerChanged`, and that connection is read only during a `computer` call: an OMP process that made one call and then saw 33 or more short-lived accessibility clients come and go (40 launches of KCalc, or 33 bare connections) hung on its next call and on every one after, on dbus-broker and dbus-daemon alike, because the listener waits for a reply queued behind its own full 64-message stream. Each such process also holds about 3.1 KB per client in dbus-broker against the user's shared 264 MiB accessibility-bus quota; with three of them the quota ran out after about 29,000 clients, the broker disconnected `at-spi2-registryd`, and a Qt 6 app started afterwards aborted at launch in libdbus (`QDBusConnectionPrivate::getNameOwnerNoCache`), the failure trycua/cua#4894 reports. On this branch the call after 1,000 clients took 0.15 s, and three idle processes held 0 bytes through 150,000 clients with the registry still up.

</details>

## Verification

After rebasing onto main: `cargo build -p pi-natives` passed; `cargo test -p pi-natives --lib desktop::linux` passed all 85 tests. Linux and Windows `scripts/rust-check` passed.

<details><summary>Live repro, regression tests and idle-bus evidence</summary>


Live, native `DesktopSession`, Ubuntu 24.04 guest (Xorg, mutter), Audacity 3.4.2, Label Sounds opened by `axPerform(press)` or `menuSelect`:

| After the dialog opens | `main` (press) | this PR (press / menu) |
|---|---|---|
| `axSnapshot` of the dialog | no answer at 30 s | `Timeout` at 5.00 / 5.00 s |
| `axSnapshot` of the window | no answer at 30 s | `Timeout` at 5.00 / 5.00 s |
| `capture` of the window | no answer at 10 s | 0.02 / 0.03 s |
| Escape to the dialog | no answer at 10 s | 0.05 / 0.05 s, dialog closed |
| `axSnapshot` after Escape | no answer at 30 s | 403 nodes in 0.61 / 0.48 s |

In two agent runs on `main` (dialog opened by `press()` in one, `menu.select()` in the other), every `computer` call after it opened ended at the 120 s run timeout.

New tests: `an_app_that_stops_answering_fails_the_read_instead_of_skipping_each_node` (`ax.rs`), six in `linux/ax.rs` `tests::unanswered` over a peer-to-peer zbus app that never answers, and `a_window_of_an_application_that_did_not_answer_reports_the_timeout` (`wayland/mod.rs`). With any guard they cover reverted, its test fails or hangs. `cargo test -p pi-natives --lib desktop::`: 215 passed (Linux).

Idle-bus case: Fedora 44 KDE Wayland guest (at-spi2-core 2.60.7, dbus-broker 37 as the accessibility bus, Qt 6.11.2), `main` 6dd7ddf5 against this branch's Cargo change, eval path with no model. One `computer.window(...).ax()`, then 40 short D-Bus connections opened and closed on the address from `org.a11y.Bus.GetAddress`, then a second call; `busctl --address=<a11y> call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.Debug.Stats GetStats` gives the queued bytes (PeerAccounting OutgoingBytes).

Not run: the Audacity case on Wayland.


</details>

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
