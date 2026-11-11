## What

I made Windows background input that holds a modifier refuse up front instead of reporting success for a chord the app received as a plain key.

Background keys, chords, held keys, clicks, drags and holds that hold Ctrl, Alt, Shift or the Windows key now throw `BackgroundUnavailable` before anything is posted, the same way the backend already refuses toolkits that drop posted input. That includes a key the layout can only type with Shift, such as `A`. With the default `computer.backgroundFallback: "takeover"` the call reruns in takeover with real input and hands focus back; with `"refuse"` it stays refused. Unmodified keys, text and plain clicks keep their background route.

The posting code for held modifiers (system-key transitions, implicit Shift/Ctrl/Alt presses, the `MK_CONTROL`/`MK_SHIFT` click flags) has no caller left and is removed.

The cost is deliberate: a classic Win32 `alt+f`, which opened the menu through the posted system-key bit, now goes through takeover too. Which chords a given window procedure honours without key state can't be told from outside the app, and the takeover rerun delivers all of them.

## Why

On Windows, background shortcuts reported success while the app got the plain key. `win.press("ctrl+s")` typed an `s` into a classic Win32, WinForms or Qt window and Save never ran; a ctrl-click on a list replaced the selection instead of adding to it. Nothing in the result told the model.

Background input on Windows is posted messages, and posting never sets the target thread's key state. Apps read Ctrl, Alt, Shift and the Windows key from that state (`TranslateMessage`, accelerators, WinForms `ModifierKeys`, Qt), so the modifiers were lost on the way in.

## Testing

Windows 11 guest, three probe windows that log the key, the modifier state and the text the app saw (a classic Win32 edit with a Ctrl+S accelerator, a WinForms form, a Qt line edit). Each trial: `win.press("ctrl+a")`, `win.type("Z")`, `win.press("ctrl+s")`, Explorer in front as the user's window, 3 trials per app.

| Per app, 3 trials each | `main` (background) | this PR, `backgroundFallback: "refuse"` | this PR, default `"takeover"` |
|---|---|---|---|
| Result of `ctrl+a`, `ctrl+s` | success | `BackgroundUnavailable`, nothing sent | success |
| Text after `ctrl+a`, `Z` | `aZ…` (`a` typed, nothing selected) | `Z` prepended, field otherwise untouched | `Z` (all text replaced) |
| Save ran | 0 of 9 | 0 of 9 | 9 of 9 |
| Focus back on Explorer | yes | yes | 9 of 9 |
| ctrl-click on a WinForms / Qt list | replaced the selection, `ctrl: false` | `BackgroundUnavailable`, selection untouched | not run |

- `posted_input_holding_a_modifier_is_refused` covers the decision: explicit modifiers, an implicit Shift (`A`), and unmodified keys that still post. It fails with the refusal disabled and passes with it.
- `rust-check` on Windows, Linux and macOS: clippy and rustfmt clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated
