## What

I left GNOME's RemoteDesktop permission dialog unanswered and the whole `computer` run died with a generic timeout, so I made the input call give up first and say why.

On GNOME Wayland the first click or keypress of a session waits for that dialog, and GNOME can open it behind other windows. Only the run's own timeout ended the wait, so the run failed with `Computer code execution timed out after 120000ms`, which the script cannot catch or explain. With this PR the call fails with `Timeout` naming the dialog shortly before the deadline, and nothing is sent.

| GNOME 50, dialog left unanswered, 120 s run | `main` | this PR |
|---|---|---|
| `computer.click` | run ends: `Computer code execution timed out after 120000ms` at 120.0 s | call throws `Timeout: the RemoteDesktop permission dialog was not answered before…` at 119.6 s |

- `desktop/control.rs`, `desktop/mod.rs`: the run deadline (`setRunDeadline`) and the request's reply-by time were macOS-only. They now also exist on Linux, unchanged; their docs say so.
- `wayland/libei.rs`: new private `until_deadline` bounds the SelectDevices → Start → ConnectToEIS step by `token.deadline()` minus 500 ms. On timeout the existing error path closes the portal session.

## Why

`Libei::portal_context` awaited the portal's `Start` response with no limit of its own; `cancellable` only reacts when the run's timeout cancels the session. The JS side already passes the run's deadline to `setRunDeadline`, but on Linux that call threw the value away. Without a run deadline the reply-by time (3 min) bounds the wait instead, so the message says "the call's deadline".

Decisions:
- **Reuse the macOS deadline plumbing** rather than a fixed timeout: a run with more time left keeps waiting for the user.
- **Leave ScreenCast's fixed 30 s `PORTAL_TIMEOUT` alone.** It already bounds that dialog.

Limitation, seen live on GNOME: closing the session does not take the dialog down, though the portal spec says [Session.Close](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Session.html#close) "ends all related user interaction (dialogs, etc)". Answering that stale dialog later does nothing; the next input call opens a fresh one. ashpd hands back the `Request` only once the dialog is answered, so OMP cannot close the dialog itself.

## Testing

- Live in a Fedora 44 KVM guest (GNOME Shell 50.6, xdg-desktop-portal-gnome 50.0) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built with `wayland-pipewire`): a screenshot, then `computer.click` with the dialog left unanswered gave the table's outcomes. With the dialog approved over VNC the click went through in 9.2 s.
- `an_unanswered_permission_dialog_is_given_up_before_the_run_ends`: a run ending inside the margin must make a never-answered wait fail with `Timeout` on its first poll; a run with an hour left lets a dialog answered after a yield through. It fails at once with the deadline ignored (a plain await), with the margin removed, or with the give-up time in the past; without the Linux plumbing it does not compile.
- `cargo test -p pi-natives --lib -- desktop::` on Linux: 208/208. `scripts/rust-check`: clean on Linux, Windows and macOS.
- Not run: the full `bun check`, KDE (its dialog opens in front).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
