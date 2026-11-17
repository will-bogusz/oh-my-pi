## What

On Wayland, `computer.capabilities()` said `displayCount: 0` until the first screenshot, which reads as "there is no screen"; I made it leave the count out until a capture actually knows it.

On Omarchy 4.5 (Hyprland), the first `capabilities()` of a session reported `capture: true` next to `displayCount: 0`, and `displays()` returned `[]`. With this PR `displayCount` is absent there, and reads `1` after the first screenshot, as before.

| Omarchy 4.5, fresh session | `main` | this PR |
|---|---|---|
| `capabilities()` before any screenshot | `displayCount: 0` | no `displayCount` |
| after one screenshot | `displayCount: 1` | `displayCount: 1` |
| macOS, Windows, X11 | a number | the same number |

**Breaking for `@oh-my-pi/pi-natives` callers:** `DesktopCapabilities.displayCount` is now `displayCount?: number`. Nothing in this repo reads it besides the type test (updated); `computer.capabilities()` passes the object to scripts as it is.

## Why

The Wayland portal names the shared monitor only when a capture opens a ScreenCast stream, so before the first one the backend has no list of displays and cannot count them. A `u32` forced it to say `0`. The field is now `Option<u32>`: Wayland returns `None` while its display list is empty, and every other backend wraps the count it already computed.

- `desktop/types.rs`: `display_count: Option<u32>`; the "no backend" capabilities keep `Some(0)`.
- `linux/wayland/mod.rs`: `None` until a capture fills `self.displays`.
- `linux/x11/mod.rs`, `macos/mod.rs`, `win32/mod.rs`: `Some(count)`, unchanged values.
- `packages/natives/native/index.d.ts` regenerated; `test/desktop.test.ts` accepts `number | undefined`.

Rejected: reporting `1` before the first capture. The portal can share any monitor, or several, and the number would be a guess.

## Testing

- Live on a fresh Omarchy 4.5 VM (Hyprland 0.56.2, xdg-desktop-portal-hyprland 1.4.1) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built from `main` and from this branch): `capabilities()` before and after the first screenshot gave the table.
- `display_count_is_unknown_until_the_first_capture` (`linux/wayland/mod.rs`): `None` with no displays, `Some(1)` once one is recorded. On `main` it doesn't compile, since the field is a plain `u32`.
- `cargo test -p pi-natives --lib -- wayland` on Linux; `scripts/rust-check` clippy and rustfmt on Linux, macOS and Windows.

Not run: `bun test packages/natives/test/desktop.test.ts` on a desktop; the edit only widens the expected type.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
