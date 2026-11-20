## What

I kept seeing the `computer` tool on Hyprland put every app window in the screen's top-left corner, so window screenshots were refused and element positions were wrong; this asks Hyprland where its windows are, read-only, and leaves other desktops alone.

On Omarchy (Hyprland 0.56.2), `computer.windows()` bounds matching Hyprland's go from **0/30 → 30/30**, and a window screenshot from refused 10/10 → the window's own 621×750 pixels 10/10.

| Omarchy 4.5, n=10 alternating builds | `main` | this PR |
|---|---|---|
| Window bounds equal to `hyprctl clients` | 0/30 (all at 0,0) | 30/30 |
| Windows listed (GTK 3 app, Files, foot terminal) | 20/30, the terminal never | 30/30 |
| Focused window agrees with Hyprland's | 5/10 | 10/10 |
| `win.screenshot()` of the GTK 3 window | 0/10: "no known screen position" | 10/10, 621×750 |
| A button's `bounds()` inside its window | 0/10 | 10/10 |
| GNOME 50.6, six calls × 3 rounds | | byte-identical to `main` |

> **Hyprland context.** A native Wayland app cannot learn where the compositor put it, so over accessibility (AT-SPI) it reports positions relative to its own window. Hyprland knows each window's position, size, workspace and process, and serves that on a local socket (`hyprctl -j clients`). OMP already places GTK 4 windows this way on X11, from the X server's window list.

## Why

- **Read only, from the real compositor.** Three reads (`j/clients`, `j/monitors`, `j/activewindow`), nothing written. Used only when the Wayland socket's peer is a `Hyprland` process that also owns the IPC socket, checked on every connection; 1 s deadline per read.
- **Never guessed.** A window takes a Hyprland client only when it is its process's only client, or its only one with that title.
- **Unchanged where a wrong answer acts.** Display keyboard input keeps `main`'s check (window focus is not keyboard focus). A window screenshot is refused if the window moved or changed workspace across the frame. If the socket does not answer, windows list as on `main`.
- **First step of a larger prototype.** Left out: skipping the per-call portal check via Hyprland's monitors (about 100 ms a call), covering-window reports, background clicks through accessibility, and keeping dialogs from taking the keyboard.
- **Maintenance.** Hyprland's JSON is unversioned; 0.57 dropped workspace ids, so workspaces match by name, and the test pins recorded output. An unreadable reply falls back to `main`'s list.

Limits: `j/clients` gives a moving window's destination, so a screenshot mid-animation can be cut from there. Nested Hyprland and scaled XWayland not run.

## Testing

- `cargo test -p omp-natives --lib desktop::linux` on Linux: 139 passed. New tests read recorded 0.56.2 JSON with 0.57 workspaces through a fake socket, pin window ownership and the crop, and pin element placement (fails with it reverted).
- Live, this head against `main`, only the addon swapped: a GTK 3 window and foot tiled on workspace 1, Files on 2, focus moved each trial. One `computer` cell per build: `windows()`, the GTK window's `screenshot()` and a button's `bounds()`, checked against `hyprctl` read right after. A script answered the screen-share picker, as a person picks the monitor.
- Not run: Hyprland 0.57 live, multiple monitors.
- `rust-check` on Linux and Windows.
