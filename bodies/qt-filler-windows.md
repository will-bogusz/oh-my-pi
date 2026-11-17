## What

On Linux, a Qt window built straight from a `QWidget` was missing from `computer.windows()`, so an agent could not find or target it; I made the window filter accept it.

On Omarchy 4.5 (Hyprland) with a Qt 6 window whose top level is a plain `QWidget`, `windows()` listed the other three test windows but not it, and `computer.window({ title: "TQW bare widget" })` failed with "no window matches". With this PR it is listed and found.

| Qt 6 window built from a bare `QWidget` | `main` | this PR |
|---|---|---|
| `computer.windows()` | not listed | listed (`tqw.py`, "TQW bare widget") |
| `computer.window({ title })` | `no window matches` | found |
| `QMainWindow` / `QDialog`, GTK, LibreOffice windows | listed | listed, unchanged |

## Why

Window listing walks each AT-SPI application's direct children and keeps those whose role marks a top-level window. Qt gives a window made from a bare `QWidget` the role `Filler` rather than `Frame`, so it was skipped. `Filler` also marks plain containers inside windows, so the change accepts it only as a direct child of the application, the same rule `FileChooser` already follows for GTK's file dialogs.

- `linux/ax.rs`, `top_level_role`: `Role::Filler` joins `Role::FileChooser` in the "top level only under the application" arm. Its three callers (window listing, `frames()`, the ownership walk) need no change: the first two only look at the application's children, and the walk passes `false` deeper in a window.

Most real Qt apps use `QMainWindow` or `QDialog` (role `Frame`/`Dialog`), so this mainly affects small tools and test windows.

## Testing

- Live on a fresh Omarchy 4.5 VM (Hyprland 0.56.2, Qt 6, `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives built from `main` and from this branch): the table, from one `windows()` and one `window({ title })` call per build.
- `file_dialogs_are_top_levels_only_under_the_application` (`linux/ax.rs`) gains a bare-`QWidget` window (a `Filler` under the application) with a button: it is a top level and owns the button, while the `Filler` already inside the GTK file dialog still is not. With the role change reverted it fails, the window missing from the top levels.
- `cargo test -p pi-natives --lib -- file_dialogs` on Linux; `scripts/rust-check` clippy and rustfmt on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
