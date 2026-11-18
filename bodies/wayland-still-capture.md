## What

On Hyprland a screenshot of a screen where nothing moved failed about half the time after a 5 s wait, so I made omp keep the screen share open between screenshots and close it 120 s after the last one.

On Omarchy 4.5 (Hyprland), 20 back-to-back screenshots of a still screen failed 9 of 20 times on `main`, each after 5.1 s with `PipeWire frame timed out`; with this PR all 20 succeeded in 119–159 ms. On sway 1.11 the same run went from 0/20 to 20/20.

**Where:** only on Hyprland, sway, river, labwc and wayfire, whose portals (xdg-desktop-portal-hyprland, -wlr) send frames only when the screen changes. omp reads the name of the process that owns the Wayland socket. Every other compositor, and an unknown one, opens and closes a share per screenshot as on `main`.

**What GNOME and KDE users see:** the same as on `main`: the indicator shows only during a screenshot.

| | `main` | this PR |
|---|---|---|
| Omarchy 4.5: 20 still-screen screenshots | 11/20; each failure after 5.1 s | 20/20 in 119–159 ms |
| Omarchy 4.5: screenshot → `zoom` (checks the layout) → screenshot, 10 tries | `zoom` 1/10, failing after 5.1–5.2 s | `zoom` 10/10; next screenshot 10/10 in 120–126 ms |
| sway 1.11, xdg-desktop-portal-wlr 0.8.4: one change on screen, then 20 still-screen screenshots | 0/20; each failure after 5.1 s | 20/20 in 114–135 ms |
| GNOME 50: 20 still-screen screenshots | 20/20 in 80–173 ms | 20/20 in 73–197 ms |
| GNOME 50: sharing indicator 3 s / 60 s after a screenshot | off / off | off / off |
| GNOME 50: gnome-shell CPU, full-screen `glxgears`, 60 s after a screenshot (3 runs; no omp: 73–84%) | 72–74% of a core | 75–86% |

## Why

A new ScreenCast stream from xdph or xdpw often gets no frame within 5 s on a still screen; a kept stream already holds the last one. On GNOME a new share got its first frame 10/10 times in 117–152 ms, while a kept one left the indicator on for 120 s and raised gnome-shell from 72% to 103% of a core under `glxgears`, so GNOME keeps `main`'s behaviour.

- `capture/share.rs`: `Shares::for_compositor` picks the path (Nix's `.<name>-wrapped` and the `hyprland` link count). `KeptShare` holds one stream and its reading thread and answers with a newer frame or, after 100 ms, the newest one. The stream closes after 120 s without a capture, when the share ends or a capture fails; the next capture asks the portal as `main` does. A layout check keeps the stream unless the layout moved.
- `capture.rs`: the per-screenshot path is `main`'s code; both paths open PipeWire through `Connection::open`, with `main`'s flags and callbacks on that path.
- `mod.rs`: the name is `/proc/<pid>/comm` of the Wayland socket's peer. `pipewire.rs`: `state_changed`, `remove_buffer`, `DONT_RECONNECT`.

120 s: of 450 gaps between screenshots in local agent sessions, two thirds were 120 s or less.

**Limits:** compositors are named, so dwl, cage or a renamed Hyprland keep `main`'s failures. A screen that never changes after the share opens still times out: on sway with nothing changing, 20/20 failed on both builds.

## Testing

- Real `computer` path on fresh Omarchy 4.5 (Hyprland 0.56.2, xdph 1.4.1), Fedora 44 sway 1.11 and GNOME 50.6 VMs: the table; Omarchy and GNOME rows on the previous head, which differs only in name matching and setup sharing. Final head: sway 20/20 in 115–136 ms, `zoom` 10/10; GNOME 20/20, indicator off at 3 s and 60 s. The stream closed 121 s after a screenshot.
- `share.rs` tests (scripted stream, injected clock): the compositor table, held frame on a still screen, idle close, lost frame, ended share, failed capture, layout check keeps or replaces.
- `cargo test -p omp-natives --lib -- wayland` and `rust-check` on Linux.

Not run: KDE, river, labwc, wayfire.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
