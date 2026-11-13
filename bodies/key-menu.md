## What

When the agent pressed Space or an arrow key on a dropdown in an app behind mine, the dropdown's menu opened and stayed open, and once omp stopped sending my keys back to my app they all went into that menu, so now the key press closes the menu the way a background click already does.

Menus left open by a background Space, Up or Down went from 70 of 70 to 0 of 70, and keys the user typed after the agent's next action in another app went from 60 of 60 lost into that menu to 0 of 60.

| | `main` | this PR |
|---|---|---|
| Space, Up or Down on a focused popup or menu button, behind the user's app | menu opens and stays open; the call reports ok | menu closed before the call returns (open 30-50 ms); `InputFailed` lists the items and names the `menu` route |
| The user's keys while that menu is open | sent back to their app during the call and for up to 30 s after, then lost into the menu, also as soon as the agent acts in another app | the menu is gone when the call returns |
| `holdKeys` of those keys on such a control | menu open for the length of the hold | `BackgroundUnavailable` before anything is sent, as for a mouse hold |
| Return, every other key, `takeover`, the target in front | posted | posted as before, nothing read |

## Why

A background click on a menu button or popup button already never leaves its menu open: `menu_watch` in `macos/input.rs` hands it to `ax::open_menu::guard`. The key route, `MacInput::window_chord`, posted the chord with no such watch, so a key that opened the focused control's menu returned with the menu tracking the keyboard. omp's key repair (`key_reroute.rs`) moves the user's keys back only while an action runs and for 30 s after, or until the next action elsewhere; from then on every key goes to the menu, where a typed Return would choose an item in the background app.

Decisions:
- **Space, Up and Down are watched; Return is not.** Return opened no menu on any of the five controls (0 of 25).
- **The wait for the menu is 250 ms**, as for context menus. Key-opened menus appeared 10 to 131 ms after the call began, Chrome's `<select>` the latest. The wait ends when the menu shows, so it costs only a watched key that opens nothing: +256 ms (817 against 561 ms, measured with Return watched). Not observed with Space, Up or Down: they opened a menu 70 of 70.
- **Roles, not apps:** `AXPopUpButton` and `AXMenuButton`, the roles clicks watch. SwiftUI pickers and Chrome's `<select>` report `AXPopUpButton`.
- **Under `computer.backgroundFallback: refuse` keys are still sent** and their menu closed. Refusing them would carry the setting through the shared key options and the host; the docs say so.

Not covered: an `NSComboBox` opened nothing that took the keyboard on `main` (Down, Up, Space, Return: 0 of 20). Date pickers were not tried. Text sent with `type()` is not checked for a space landing on a focused popup.

## Testing

On a macOS 26 VM: a Probe app in front, typed into through the VM's VNC keyboard (20 keys, 80 ms apart, from 0.3 s before the call), and one `el.press(key)` (`win.press` too for the popup button) to an AppKit popup button, a pull-down menu button, a combo box, a SwiftUI picker and a Chrome `<select>` in background windows; 5 tries per cell.

| Watched keys, 14 cells | `main` | this PR |
|---|---|---|
| Menu left open after the call | 70 of 70 | 0 of 70 |
| Probe's window lost key status | 70 of 70 | 70 of 70, for the 30-50 ms the menu shows |
| Keys lost during the call | 0 of 1,400 (sent back) | 0 of 1,400 |
| Keys lost when typing starts after the agent's Shift press in another app | 60 of 60 (3 tries) | 0 of 60 |
| Keys lost when typing starts 31 s later | 60 of 60 (3 tries) | 0 of 60 |
| Call reports | ok, 70 of 70 | `InputFailed` listing the items, 70 of 70 |

<details><summary>Per cell, timing, and the typist that is not a keyboard</summary>

Per control, `main` → this PR, 5 tries per key (VNC keyboard). "Open" is the menu still open after the call; every watched key opened its menu on both.

| Control (role) | Space | Down | Up | Return | Menu appeared after the call began |
|---|---|---|---|---|---|
| Popup button, `el` + `win` (`AXPopUpButton`) | open 10/10 → 0/10 | open 10/10 → 0/10 | open 5/5 → 0/5 (`el`) | no menu, 10/10 both | 10-55 ms |
| Pull-down (`AXMenuButton`) | open 5/5 → 0/5 | open 5/5 → 0/5 | open 5/5 → 0/5 | no menu | 13-44 ms |
| SwiftUI picker (`AXPopUpButton`) | open 5/5 → 0/5 | open 5/5 → 0/5 | open 5/5 → 0/5 | no menu | 12-53 ms |
| Chrome `<select>` (`AXPopUpButton`) | open 5/5 → 0/5 | open 5/5 → 0/5 | open 5/5 → 0/5 | no menu | 54-131 ms |
| Combo box (`AXComboBox`, not watched) | no menu, 0 lost | no menu, 0 lost | no menu, 0 lost | no menu | - |

Time per call for keys that open no menu, median ms over 20 calls each, `main` and this PR alternating in one guest: a letter in a text field 586.5 / 587.3 (`el`), 582.2 / 582.0 (`win`); Tab 561.1 / 562.1, 551.5 / 550.8; Return 560.0 / 560.7, 551.6 / 551.4; Down in a text field (role read, not a menu control) 561.8 / 564.4, 551.9 / 550.1; Tab on the popup 562.7 / 560.8, 554.0 / 553.3. A watched key that opens its menu now takes about 600 ms (about 560 on `main`) and fails.

The error a watched key now returns: `InputFailed: the key press down reached window 48 (Fixture) and opened a menu, which takes the keyboard from the user's app, so it was closed with nothing chosen; the key press may already have taken effect, so inspect the window before retrying. To choose an item in the background, press or click the control instead of sending keys, with the item's path as the menu option, e.g. menu: ["<item>", "<subitem>"]. Items: "Alpha", "Beta", "Gamma".`

A typist that posts its keys from a process (at the HID tap) is not moved back by the key repair, which moves only keys no process posted. With it, `main` lost 799 of 1,000 keys during the call (Space and Down, 50 tries); this PR loses 9 of 400 (Down, 20 tries, at most 1 per try) during the 30-50 ms the menu shows before it closes.

</details>

Unit tests: `cargo test -p pi-natives --lib -- menu keys_that chord hold` (103 passed on macOS). The new `key_menu_guarded` and `refuse_key_menu_hold` tests do not compile with the fix reverted.

Not run: a model sample for the one-line tool-prompt change, which now names Up and drops Return; the change only narrows which keys the prompt says close their menu.
