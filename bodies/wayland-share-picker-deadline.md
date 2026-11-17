## What

When a Wayland screenshot opens the screen-share picker, I made the call wait for the user's answer until the call's deadline, the way input already waits for the RemoteDesktop dialog, instead of giving up after 30 s while the picker stays on screen.

On Omarchy 4.5 (Hyprland), with no stored grant and the picker answered 40 s after the screenshot started, the screenshot failed 5/5 times at 32 s with `CaptureFailed: Wayland ScreenCast portal timed out`, and the picker the user then answered captured nothing. With this PR it returned the capture 5/5 times at 40.2 s.

| Omarchy 4.5, no stored grant | `main` | this PR |
|---|---|---|
| picker answered after 40 s (5 tries) | 5/5 fail at 32.1 s, the answer is lost | 5/5 captured at 40.2 s |
| picker left unanswered, 3 screenshots in one run | each fails after 30–32 s with `CaptureFailed: … portal timed out`; the picker stays open | each waits until its deadline (117.5–119.5 s here) and fails with `Timeout: the screen-share portal did not answer before the call's deadline…`; the picker stays open |

## Why

Two of the ScreenCast steps wait on the user, and which one depends on the desktop: GNOME and KDE show their dialog during `Start`; xdg-desktop-portal-hyprland runs its picker inside `SelectSources` and serves one request at a time, so while the picker is open the next `CreateSession` waits behind it too. All three were bounded by `PORTAL_TIMEOUT` (30 s), a limit meant for portal calls that don't wait on anyone.

- `wayland/portal.rs`: `until_deadline`, added for the RemoteDesktop dialog, moves here from `libei.rs` and takes the `Timeout` message as an argument; libei passes its own message unchanged.
- `wayland/capture.rs`: new `picker_request` bounds `CreateSession`, `SelectSources` and `Start` by the call's deadline (the run's end or the request's reply time) minus the margin `until_deadline` already keeps for closing the session. `Screencast::new` and `OpenPipeWireRemote` keep the 30 s bound.
- The `Timeout` says the screen-share portal did not answer before the deadline and, if it showed a picker, to ask the user to answer it. It doesn't claim a picker was shown, since a hung portal ends the same way.

**Beyond screenshots:** a coordinate click that has to refresh the display geometry goes through the same steps, so with no stored grant it now waits on the picker too and fails with `InvalidCoordinateFrame` wrapping that `Timeout`. On `main` it failed the same way after 30 s.

Unchanged: the stored grant still skips the picker after the first answer.

## Testing

- Live on a fresh Omarchy 4.5 VM (Hyprland 0.56.2, xdg-desktop-portal-hyprland 1.4.1) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built from `main` and from this branch). xdph was pointed at a scripted picker (`custom_picker_binary`) that answers when the harness tells it to, so "the user answers after 40 s" is exact; xdph and the portal were restarted before each try.
- `until_deadline`'s tests (`an_unanswered_permission_dialog_is_given_up_before_the_run_ends`) now pass the message; they cover giving up before the deadline and letting a later answer through. The capture path itself needs a live portal, so the VM run is its test.
- `cargo test -p pi-natives --lib -- wayland` on Linux; `scripts/rust-check` clippy and rustfmt on Linux.

Not run: GNOME and KDE, where the dialog opens in `Start` and `main`'s bound was the same 30 s.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
