## What

I gave every Linux AT-SPI request a 5 s limit and a cancel, and stopped OMP connecting to every app on the desktop, because one `ax()` read of an app whose dialog `press()` had just opened froze the `computer` tool for the rest of the session, and OMP's connection to every app kept that dialog from taking typed input.

In Audacity's Analyze ▸ Label Sounds…, a read of the app went from hanging every later `computer` call to the 120 s run timeout to a `Timeout` error after 5 s, with screenshots and input working at once.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/3eaf1da9-931b-48ef-820f-b01e42c7fbee">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/e60134a7-96a8-415a-80b3-a35970bbb93f">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/e87aa674-3b17-4fa4-91b5-24ed3eba9edc">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/f11c95c9-c5a1-42fc-908c-9fcffcc300ef">
  <img width="780" alt="Timeline, main against this PR, after press() on Audacity's Analyze > Label Sounds... opens a modal dialog. main: the press returns and the dialog ignores typed input, ax() waits forever because Audacity answers no AT-SPI call, screenshot and Escape queue behind it and each call ends at the 120 s run timeout for the rest of the session, and ax() never runs again. This PR: the press returns, ax() fails with Timeout after 5 s, naming Audacity, the screenshot and Escape run at once and Escape closes the dialog, and ax() reads the window again." src="https://github.com/user-attachments/assets/e60134a7-96a8-415a-80b3-a35970bbb93f" />
</picture>

> **AT-SPI context.** On Linux, `ax()`, `press()` and `menu.select()` are D-Bus calls into the app, served on its main loop. GTK 3 apps reply to a press before running it inside their D-Bus handler ([`impl_DoAction`](https://gitlab.gnome.org/GNOME/at-spi2-core/-/blob/main/atk-adaptor/adaptors/action-adaptor.c)), so a press that opens a modal dialog leaves the app answering nothing until it closes. libatspi gives each call [800 ms](https://gitlab.gnome.org/GNOME/at-spi2-core/-/blob/main/atspi/atspi-misc.c); OMP waited forever.

<details><summary>Reading order (crates/pi-natives/src/desktop/)</summary>

- `linux/ax.rs`: `REPLY_TIMEOUT`, `AtSpiAx::run` (cancellable wait), `request` (one limit for a request) and `reply` (one limit per call, for whole-app and menu reads), used by every `AxBackend` method and `linux/ax/menus.rs`.
- `linux/ax.rs` per-app enumerations: `windows`/`app_windows`, `app_for_window`, `element_at`/`frames_at`, `focused_element`/`find_focused`.
- `Backend::missing_window` and `wayland/mod.rs`: a Wayland window or focus lookup that misses an app `windows()` skipped fails with `Timeout`, not "not found".
- `linux/ax.rs` `AtSpiAx::new`: the bus address from `org.a11y.Bus`, no peer connections; `Cargo.toml` drops atspi's `connection`/`p2p` features (zbus `p2p` stays for the test fixtures only).
- `ax.rs` `walk_raw`: a `Timeout` or `Cancelled` ends the walk instead of being skipped node by node.
- `control.rs` `cancellable`: moved unchanged from `wayland/libei.rs`.

</details>

## Why

Every AT-SPI call ran in `rt.block_on` on the one desktop worker thread with no limit, so the read never returned, every later request queued behind it, and the host's cancel could not interrupt it.

`atspi::AccessibilityConnection::new` also connects to every app peer to peer (atspi-connection's default `p2p`). One app not answering hung every new session and `menu.select()`, and with those connections open Audacity's dialog ignored typed input.

Decisions:
- 5 s per request, not libatspi's 800 ms per call: a request makes up to a dozen calls, and a LibreOffice text edit takes 1.75 s. Menu walks, hundreds of calls, bound each call.
- zbus's `method_timeout` covers `Connection::call_method` only, not proxy calls.
- `windows()` and focus search skip an app that does not answer; `elementAt()`, a window lookup without a pid, and a Wayland lookup of a skipped app's window fail with `Timeout`.
- A press, value or menu command that times out may still run later; the error says so.

Not here: `click()` on a closed menu's item failing with `InvalidCoordinateFrame`.

## Testing

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

Not run: Wayland live.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
