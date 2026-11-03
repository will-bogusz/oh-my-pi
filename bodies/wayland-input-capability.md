## What

On sway, `computer.capabilities()` promised input that could never work, so I made it check for the RemoteDesktop portal first and say so.

On sway and other wlroots desktops, `capabilities()` reported `input: true` and `inputPermission: "prompt-or-granted"`, but no xdg-desktop-portal backend there implements RemoteDesktop, so every click and key failed. Now it reports `input: false`, `heldInput: false` and `inputPermission: "unavailable"`, and typing and key presses fail at once naming the missing portal. Coordinate input still stops first at its screenshot-frame check, as on `main`.

| sway 1.11 (xdg-desktop-portal-wlr 0.8.4 + -gtk) | `main` | this PR |
|---|---|---|
| `capabilities()` | `input: true`, `heldInput: true`, `prompt-or-granted` | `input: false`, `heldInput: false`, `unavailable` |
| `computer.type("x")` | `PermissionDenied: RemoteDesktop portal unavailable: …` | `PermissionDenied: Wayland input is unavailable: no xdg-desktop-portal backend implements RemoteDesktop on this desktop …` |
| GNOME 50 / KDE 6.8 `capabilities()` | `input: true`, `prompt-or-granted` | the same |

- `wayland/portal.rs`: new `input_unavailable_reason`. It only builds the RemoteDesktop frontend proxy, which reads its properties, with a 2 s limit: no session and no prompt. Only `PortalNotFound` counts as unavailable; any other answer leaves the lazy RemoteDesktop request to decide, as before. `LIBEI_SOCKET` skips the probe.
- `wayland/mod.rs`: the backend runs the probe once, on the first `capabilities()` or input call, and keeps the answer for the session.
- `docs/computer-use.md`: the Wayland capabilities paragraph names the new state.

## Why

`capabilities()` hard-coded `input: true`. A model planning from it on sway tried input it could never get, and learned otherwise only from the first failure.

Decisions:
- **No prompt in the probe.** Reading properties cannot open a dialog, so read-only calls stay prompt-free (#7884).
- **A definite absence only.** A slow or broken portal still reports `prompt-or-granted`, so this never turns input off where it might work. A portal that misses the 2 s window keeps that answer for the session, as `main` always did.

Non-goals: input on wlroots without a portal (virtual-pointer and virtual-keyboard protocols); that is a separate backend.

## Testing

- Live in Fedora 44 KVM guests through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built with `wayland-pipewire`), `main`'s addon against this branch's, on sway, GNOME Shell 50.6 and Plasma 6.8.2.
- Unit tests:
  - `a_desktop_without_a_remote_desktop_portal_reports_and_refuses_input`: capabilities and a `type_text` refusal with the reason, no libei connection attempted.
  - `only_a_missing_remote_desktop_portal_makes_input_unavailable`: from a thread outside any runtime, with the portal's answer injected: `PortalNotFound` gives the reason, `NoResponse` and success give none. A first draft built the timeout outside the runtime and panicked there ("no reactor running"); the GNOME run caught it, and this test now does.
  - `a_direct_eis_socket_skips_the_portal_probe`: with `LIBEI_SOCKET`, the portal is never asked.
- `cargo test -p pi-natives --lib -- desktop::linux`: 61/61 on Linux. `scripts/rust-check`: clean on Linux.
- Not run: the full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
