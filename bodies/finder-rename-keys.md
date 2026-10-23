## What

I watched an agent rename a copy of a form in Finder, then give up and ask me to press Return, because every way it tried to commit the name was refused; now keys and element calls reach Finder's rename field, and clicks reach the folder window under it.

| While Finder renames a file | `main` | this PR |
|---|---|---|
| `win.press("enter")` to the rename field's window, Finder frontmost | refused: `UserIntervened`, "not its key window" | Return reaches the field |
| the same, Finder in the background | the press that makes the window key lands outside the field, which ends the rename | activation only, as a click into the field already gets |
| `el.type` / `el.press` on the field | `AxFailed`: "AX element has no identifiable owning window" | sent to the field |
| a click in the folder window, Finder frontmost | refused: `UserIntervened` | clicked, which ends the rename as a user's click does |

> **macOS context.** While you rename a file, Finder draws the name field as a small window of its own, attached to the folder window, lists it among its accessibility windows, and reports no focused window at all; the field holds the keyboard focus.

## Why

`windows()` already lists the field's window as focused, but three checks read only the focused window or an element's `AXWindow`, both empty during a rename:

- `KeyFocus::in_overlay_of` counted an overlay attached to the target, not the target being that overlay, so keys for the field's own window were treated as keys for a plain window: refused while Finder is frontmost, made key with a press otherwise.
- The frontmost-app guard in `make_key_in_background` refused any target that was not `AXFocusedWindow`. It now asks where the app's keys go (`keys_reach`, over `KeyFocus::destination`, the rule background typing already uses to prove its keys land), so the folder window under the field counts as key, and another Finder window still refuses.
- `MacAx::window_id` found no window above the field. An element that is itself one of the app's `AXWindows` now maps to its own window id, which is how `win.ax()` already resolves that window to the field; other window-less elements, such as open menus, still fail.

Decision: no Finder-specific code. Any app that reports no focused window while the focused element sits in the target, or in a window attached to it, now passes the frontmost guard for that target; the user's keys already go there, so nothing moves. Review first: the guard now reads the focused element as well as the focused window, only when the target's app is frontmost.

Non-goal: menu commands during a rename. `menu.select` still needs a reported key window and still refuses, now with `BackgroundUnavailable` from the menu's own key-window check after its 250 ms wait instead of `UserIntervened`.

## Testing

- The failure: a recorded GPT-6.1 Sol run of a Finder form-copy task on `main` got `UserIntervened` on the field's window twice, `AxFailed` on the field twice, `UserIntervened` for a click in the folder window and for `menu.select`, then ended asking the user to press Return.
- `cargo test -p pi-natives --lib desktop::` on macOS: 473 passed, 0 failed. `the_frontmost_applications_key_window_is_where_its_keys_go` fails under `main`'s focused-window rule; the extended `an_editor_overlay_attached_to_the_target_holds_its_focus` fails with the `in_overlay_of` change reverted.
- `scripts/rust-check`: clippy `--all-targets` and rustfmt pass on macOS and Linux.
- Not run: a live rename on this head, including the background row and `el.type` on the field; no macOS guest was available to this run.
