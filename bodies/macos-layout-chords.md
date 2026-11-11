## What

I wanted `win.press("cmd+a")` to select all on a French keyboard instead of quitting the app.

Local key chords on macOS (`press`, `holdKeys`, desktop and window targets, background and takeover) posted each character on its US (ANSI) key code. An app reads a key code through the current layout, so on French AZERTY `cmd+a` arrived as Cmd+Q and quit the app, `cmd+z` as Cmd+W and closed the window, a bare `z` typed `w`, and `1` typed `&`; the tool reported each as done. The layout lookup already existed for remote screens (Screen Sharing, iPhone Mirroring); local chords skipped it.

Now a local chord's characters go through the current layout too:
- a Command chord takes the key of the layout's Command layer, which is what an app matches a shortcut against (Russian puts Latin letters there, so `cmd+c` still copies);
- a bare character takes its typing key with the Shift or Option it needs;
- a Control or Option chord takes the layout key only when it needs no modifier the chord does not name, so AZERTY `ctrl+1` stays Ctrl on the `1` key, as the user presses it;
- a character the layout lacks, a layout without key data, or a failed layout read leaves the character on its ANSI key, as before. A chord with no character (`enter`, `cmd+tab`) reads no layout. Two limits stay as on main: a Command chord whose character the Command layer lacks (`cmd+/` on German or AZERTY) stays on its ANSI key, and keys held around clicks, drags and `holdMouse` still use ANSI keys.

Typed text is unchanged: local `type` still sends Unicode event text, which 3e90f2f (PR 15193) settled. Chords were always key codes locally, so they cannot carry text and only the layout says which key a character is on.

## Why

On a French Mac the agent's first select-all quit the user's app, losing unsaved work, and the tool reported the key as pressed.

## Testing

TextEdit in a macOS 26.5.2 VM with Finder in front, addon swapped into `@oh-my-pi/pi-coding-agent`; each trial: `win.press("cmd+a")` then `win.type("Z")`; `win.type("hello")` then `win.press("cmd+z")`; `win.press("z")` then `win.press("1")`.

| French AZERTY | main | this branch |
|---|---|---|
| `cmd+a` selects all (background / takeover) | 0/5, TextEdit quit 5/5 / 0/5, quit 5/5 | 5/5 / 5/5, no quit |
| `cmd+z` undoes | 0/5 / 0/5 | 5/5 / 5/5 |
| `z`, `1` type `z1` | `w&` every time | `z1` in takeover; `Z1` in the background |

On Russian, where the Command layer already matches ANSI, `cmd+a` and `cmd+z` worked on both builds (5/5), and a bare `z`, which no Russian key types, still falls back to the ANSI key (`я`). The capital `Z` and `Я` from a background bare key are the same on main (Russian `Я1` there too) and are not this change. A background `cmd+a` took 786 ms cold (keymap older than its 10 s cache) and 728 ms warm here, against 772 and 734 ms on main (3 each).

`local_chords_press_the_layouts_key_and_command_shortcuts_its_command_layer` passes here; its `cmd+a` assertion, run through main's `chord_keys`, fails there (key 0, not 12). It also covers `ctrl+1`, a character-free chord reading no layout, and failed and cancelled reads. `command_shortcuts_map_to_the_key_of_the_layouts_command_layer` covers the keymap's Command layer.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
