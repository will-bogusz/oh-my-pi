## What

On Hyprland and other desktops with no input route, I made every pointer and keyboard call refuse the same way, straight away, instead of sending the agent off to take a screenshot for input that can never happen.

On Omarchy 4.5 (Hyprland), a click or scroll used to fail one of three ways depending on what came before it: "take a screenshot first" before any capture, a 5 s wait ending in `InvalidCoordinateFrame` after one, or `PermissionDenied` after up to 2.5 s. With this PR all of them return `PermissionDenied` naming the missing RemoteDesktop portal in under 5 ms (the first call of a process takes about 60 ms, which is the portal probe).

| Omarchy 4.5, no RemoteDesktop portal | `main` | this PR |
|---|---|---|
| click / scroll before any screenshot (10 fresh processes each) | 20/20 `InvalidCoordinateFrame: no capture of 'desktop' yet — take a screenshot of this target first` | 20/20 `PermissionDenied` |
| click / scroll after a screenshot (10 rounds each) | 9/20 `InvalidCoordinateFrame` after 5.07 s, 11/20 `PermissionDenied` after 0.09–2.5 s | 20/20 `PermissionDenied` in ≤ 4 ms |
| type (20 calls) | `PermissionDenied` | `PermissionDenied`, unchanged |

`el.click()` and `el.doubleClick()` click at the element's bounds with the pointer, so they now get the same refusal. Semantic element actions (`el.press()`, `el.type()` text insertion through AT-SPI) are untouched, which is what the refusal points agents to.

## Why

The worker resolved a coordinate call's frame before asking the backend whether it can send input at all. Resolving the frame needs a capture, and on Wayland it also refreshes the display geometry by opening a ScreenCast stream, which on a still Hyprland screen waits 5 s for a frame that never comes. Only after that did libei's portal check refuse. Typing has no frame, so it already refused straight away.

- `desktop/backend.rs`: new `Backend::refuse_input`, `Ok(())` by default, so macOS, Windows and X11 are unchanged.
- `desktop/mod.rs`: the worker asks it first for every pointer and keyboard request (`click`, `moveMouse`, `drag`, `scroll`, `type`, `keyChord`, `holdKeys`, `holdMouse`, element `click`), after a cancellation check and before it waits for the input lease another session may hold or resolves the target or frame.
- `linux/wayland/mod.rs`: answers it from the existing cached RemoteDesktop/`LIBEI_SOCKET` probe, which `run_input` now also calls, so the two can't drift apart.

With no input route, a window target now gets this refusal rather than `BackgroundUnavailable`, since its advice to use desktop input couldn't work either.

## Testing

- Live on a fresh Omarchy 4.5 VM (Hyprland 0.56.2, xdg-desktop-portal-hyprland 1.4.1, PipeWire 1.6.9) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built from `main` and from this branch's first version, with the check inside each arm): the counts in the table.
- `every_input_call_is_refused_before_its_frame_when_input_is_unavailable` (`desktop/mod.rs`, runs on every OS): with another session holding control, each of the 9 input requests to a backend with no input route must fail with `PermissionDenied` with no capture, window lookup or click. Against this PR's first version (a check inside each arm, after the lease) it fails with `InputBusy`.
- `cargo test -p pi-natives --lib -- wayland every_input_call` on Linux; `scripts/rust-check` clippy and rustfmt on Linux, macOS and Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
