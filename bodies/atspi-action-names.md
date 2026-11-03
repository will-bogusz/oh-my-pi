## What

In Firefox, Chromium, VS Code and LibreOffice on Linux, `press()` refused every button with "AT-SPI action 'press' is unavailable", so I made OMP match actions by the name AT-SPI defines for that instead of the label apps translate for screen readers.

| Live, Fedora 44 guests | `actions()` on `main` | `main` | this PR |
|---|---|---|---|
| Firefox 159, form button (GNOME, KDE) | `[";;"]` | `press()`, `perform("press")` refused | both press it (page counter 5 → 7) |
| Chromium 156, button and checkbox | `["", ""]` | refused | pressed (counter 2 → 3), checkbox checked |
| VS Code 1.144, Toggle Panel | `["", ""]` | refused | panel opens and closes (Terminal tab 0 → 1 → 0) |
| LibreOffice 26.2 Writer (GTK3), Bold | `["", ""]` | refused | pressed |
| Kate, GNOME Text Editor (GTK4) | `["Press"]`, `["Click"]` | pressed | pressed, `actions()` reads `["Press"]`, `["click"]` |

- `linux/ax.rs` `action_names` reads `NActions` (capped at 256: the app supplies it), then every `GetName(i)` at once; `props().actions`, `perform()` (through `resolve_action`) and `menu_select` use it. `Self::action` skips zbus's property cache, whose `GetAll` Qt refuses, so `NActions` would fail on every Qt element.
- `resolve_action`: a generic press of a toggle button falls back on its `check`/`uncheck` action, as checkboxes already did; VS Code's Toggle Panel has only `check`.

**Beyond the fix:**
- `actions()` lists untranslated names: GTK3 lists `click` where `main` listed `Click`, Qt keeps `Press`, and under a non-English locale every toolkit's list changes from translated labels (`Klicken`) to these names.
- Every action an app advertises can now be performed by name, not only press. Chromium and Electron advertise `showContextMenu`, so `perform("showContextMenu")` now opens a context menu where `main` refused it for want of a name. Qt's `ShowMenu` was already performable in English.

## Why

AT-SPI's `GetActions` returns each action's localized name, for screen readers: Firefox fills it with `;;`, Chromium, Electron and LibreOffice's GTK3 build leave it empty, and every toolkit translates it. libatspi, which Orca uses, calls `GetName`, documented as "the non-localized name of the action" (`atspi_action_get_action_name` in at-spi2-core): `press` in all four apps above. An element with no activation action is still refused.

`GetName` costs one call per action, sent together; `GetActions` has nothing to parse when the name is empty.

## Testing

- Live in Fedora 44 KVM guests (GNOME Shell 50.6, Plasma 6.8.2, at-spi2-core 2.60.7) through the real path (`AgentSession` → eval → `computer` prelude → pi-natives), `main`'s addon against this branch's. Firefox and Chromium don't update their accessible text while covered, so their counters were read from a screenshot after raising each window.
- `actions_match_by_machine_name_not_localized_name` serves elements on a peer-to-peer D-Bus connection that answers like the apps: localized `GetActions` (Firefox `;;`, a German GTK app, Chromium's checkbox, VS Code's toggle), `GetName` with machine names, `GetAll` refused as Qt refuses it, and one element claiming `NActions = i32::MAX`. Each regression fails it: `action_names` reading `GetActions` again (all five expected matches miss), `Self::action` with zbus's property cache (every `NActions` read errors), and the cap removed (the test aborts on allocation).
- `cargo test -p pi-natives --lib -- desktop::linux`: 59/59. `scripts/rust-check` linux: clean.
- Not run: `menu.select()` live (no guest app has a menu bar OMP's menu walk reaches), a non-English locale, the full `bun check`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
