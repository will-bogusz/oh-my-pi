## What

On Hyprland a screenshot of a screen where nothing moved failed about half the time after a 5 s wait, so I made omp keep the screen share open between screenshots and close it 120 s after the last one.

On Omarchy 4.5 (Hyprland), share granted, 10 back-to-back screenshots of a still screen failed 10 of 20 times on `main`, each after 5.06–5.09 s with `CaptureFailed: PipeWire frame timed out`. With this PR all 20 succeeded, in 107–115 ms each.

| | `main` | this PR |
|---|---|---|
| Omarchy 4.5: 10 still-screen screenshots, twice | 10/20 fail after 5.1 s; the rest 94–3132 ms | 20/20 in 107–115 ms |
| Omarchy 4.5: first screenshot of a fresh process (10 runs) | 150–222 ms | 109–125 ms |
| GNOME 50: 10 still-screen screenshots, twice | 20/20 in 79–224 ms | 20/20 in 112–159 ms |
| GNOME 50: sharing indicator 3 s / 60 s / 130 s after a screenshot | on / off / off | on / on / off |
| GNOME 50: Stop pressed in the indicator, then a screenshot (3 tries) | n/a | stream closed within 3 s; the next screenshot opened a new share (82–91 ms) |

**What GNOME and KDE users see:** the screen-sharing indicator stays on while an agent is taking screenshots and goes off about 120 s after the last one, instead of coming on per screenshot.

## Why

Each screenshot opened a new ScreenCast stream and waited for its first frame. xdg-desktop-portal-hyprland (and -wlr) send frames only when the screen changes, so on a still screen a new stream often got none within 5 s. A stream kept open already holds the last frame.

- `wayland/capture.rs`, `Cast`: keeps one stream (portal session plus a reading thread) between captures.
- `serve`: keeps the newest buffer the compositor sent and returns older ones at once; answers a capture with a newer frame or, after 100 ms, that buffer. Pixels are converted only when a capture asks.
- The stream closes 120 s after the last capture, when it ends (Stop in the indicator), when a capture from it fails, or with the backend. Captures waiting on an ended stream fail; the next one opens a new share through the same portal request as `main` (stored grant or picker).
- Coordinate validation replaces the kept stream with a new one, which reports the current layout; until then screenshots keep the layout the share started with.
- `wayland/pipewire.rs`: `state_changed` and `remove_buffer` callbacks; `DONT_RECONNECT`, so an ended share is never relinked to another source.

Why 120 s: in 450 gaps between consecutive screenshots in local agent sessions, the median was 34 s and two thirds were 120 s or less.

## Testing

- Live through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built from `main` and from this branch) on a fresh Omarchy 4.5 VM (Hyprland 0.56.2, xdg-desktop-portal-hyprland 1.4.1, PipeWire 1.6.9) and a Fedora 44 GNOME 50.6 VM: the table. On Omarchy the stream thread, sampled every 5 s after one screenshot, was there through 110 s and gone by 115 s. With the share ended under an open stream (portal restarted), 5/5 times the stream closed within 3 s and the next screenshot opened a new one. The VM rows predate the last review fixes (failure paths and validation), which don't change a capture that succeeds.
- `capture.rs` tests (scripted stream, injected clock): still screen served from the held frame; close at exactly `STREAM_IDLE`; timeout when the held frame goes away; a stop fails every waiting capture, then one reopen; a failed capture closes the stream; validation replaces it.
- `cargo test -p pi-natives --lib -- wayland` on Linux; `scripts/rust-check` on Linux.

Not run: KDE.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
