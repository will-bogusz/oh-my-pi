## What

I saw OMP report background typing into Qt apps on X11 as done while Qt never saw a key, because Qt takes keys only as core X events and OMP's virtual keyboard sends none; now those calls refuse before sending anything, so the `computer` tool reruns them in takeover and the text lands.

Background `type`/`press` into a Qt 5 or Qt 6 window under GNOME: `main` reports success with 0 keys received; this PR delivers the text through takeover and hands focus back.

> **X11 context.** Background input drives a second "master" keyboard (XInput2 MPX) created with core events off, because core events from it make window managers activate the target. GTK and Chromium read keys through XInput2 and get them; Qt 5/6's xcb plugin reads XInput2 for the pointer only (`qxcbconnection_xi2.cpp` never selects key events), and it drops `XSendEvent`, so no background key route reaches it.

| Background call into a Qt window | `main` | This PR |
|---|---|---|
| `type`, `press`, `holdKeys` | reports success; the app receives no keys | `BackgroundUnavailable` before sending; takeover per `computer.backgroundFallback` |
| `drag`/`holdMouse` with `keys` (Space-drag) | reports success; the button arrives, the key does not | `BackgroundUnavailable` before sending |
| `click`, `scroll`, `drag` with `modifiers` | delivered | delivered |
| GTK (gedit), Chrome, Chrome with its Qt theme | delivered | delivered |

## Why

A success the app never received is worse than a refusal: the model goes on as if the text were typed. The refusal uses the existing `BackgroundUnavailable` contract, so `computer.backgroundFallback` decides between takeover and refusing, as for every toolkit OMP cannot reach in the background.

Decisions:
- Qt is recognised by its xcb plugin in the target's memory map (`libQt5XcbQpa.so`, `libQt6XcbQpa.so`), as `toolkit.rs` already recognises GTK and Qt for `XSendEvent`. Chrome loads that plugin for its Qt theme (default on LXQt, UKUI, Deepin) yet reads keys through XInput2, so a process that also maps Chrome's `libqt5_shim.so`/`libqt6_shim.so` is not refused.
- Core events on the virtual keyboard would reach Qt but bring back the window-manager activation `main` turned them off to avoid.

Limits, each silent as on `main`: Flatpak Qt apps (sandbox pid), statically linked Qt (Telegram Desktop) and `ssh -X` clients are not recognised. A GTK file dialog of a Qt app carries the Qt pid and runs in takeover.

Reading order: `process_reads_core_keyboard` (`x11/toolkit.rs`), then its checks in `X11Input::background_keys` and `X11Input::pointer` (`x11/input.rs`).

## Testing

- `qt_xcb_clients_read_core_keyboard_events`: Qt 5 and Qt 6 xcb plugins recognised; GTK, and Chrome's Qt shim beside the plugin, not.
- Live, Ubuntu 24.04 VM, Xorg 21.1.11, mutter 46.2, PyQt5 and PyQt6 editors that log every key and click, behind gnome-system-monitor, refused calls rerun in takeover as the tool does:
  - `press(ctrl+End)`, `type(" BGMARK")`, `press(ctrl+s)`: `main` reports success, 0 keys logged, file unchanged; this PR refuses each in about 2 ms, the reruns log 16 keys, file saved, System Monitor active again. FeatherPad (Qt 5) matched `main`.
  - `drag(…, { keys: ["space"] })`: `main` success, only the click logged; this PR refuses, the rerun logs Space and the click.
- Background typing into gedit, Chrome for Testing, and Google Chrome 156 with `XDG_CURRENT_DESKTOP=LXQt` (maps `libqt5_shim.so` and `libQt5XcbQpa.so`) delivered on both.
- `scripts/rust-check` on Linux.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
