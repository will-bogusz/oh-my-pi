## What

I made keys and typing for a macOS window go into the sheet that's open and focused on it, like an Open panel or Go to Folder, instead of refusing and naming the sheet's window id.

On a computer-use benchmark task that picks a folder through Automator's Open sheet, every OMP run hit this refusal twice (⌘⇧G on the document window, then Return in the Go to Folder field) and spent a call each time looking up the sheet's id; with this branch both go through in the background.

> **macOS context.** A sheet (Open, Save, Go to Folder) is its own window attached to a document window. While it is up the document window cannot become key, and macOS sends every key the app gets to the sheet. A sheet's controls report the document window as their `AXWindow`, so `el.press()` on them is addressed to the document window.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/01f47d75-316a-4784-ac59-ac5ea42239ec">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/716fd223-6760-454c-84b8-bf91fe0bccc9">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/45cb1f46-aa68-4505-a093-9c4f2f7a88f4">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/cfe0b3d4-02cd-4042-aaa6-214625f4dd0a">
  <img width="780" alt="Decision flow: where keys pressed for a macOS window go when it has sheets open. First: does a sheet attached to the window, or to a sheet on it, hold keyboard focus? If no, nothing changes from main. Second: are the keys pressed in a control rather than sent to the window? If no, main refuses, naming the sheet, and this PR sends them to the sheet. Third: is the control drawn in the window that holds the focused element? If no, main and this PR both refuse with nothing sent. If yes, main refuses and this PR sends the keys to the control in the sheet. Footer: drawn from sheet_key_target and key_window in crates/pi-natives/src/desktop/macos/input.rs; main refuses with InvalidTarget, or InputFailed in takeover; a focused popover or child window that is not a sheet is refused as on main; text typed into a control's native field (el.type) is inserted through accessibility whatever this flow shows, on main and with this PR." src="https://github.com/user-attachments/assets/716fd223-6760-454c-84b8-bf91fe0bccc9" />
</picture>

Reading order: `key_window` and `sheet_key_target` in `crates/pi-natives/src/desktop/macos/input.rs`, called from `MacInput::type_text`, `key_chord`, `hold_keys` and `element_input`; then `ax::focused_sheet_id`.

## Why

`main` refuses these keys on purpose, since typing meant for a Finder window once landed in its Go to Folder sheet while the call reported success for the window. For keys addressed to the window itself that refusal buys nothing: the sheet is in that window's own `ax()` tree, a user's keys would go there, and the agent's next call sends the same keys to the sheet's id. The refusal stays where it protects something: keys pressed in a control of the window under the sheet, or of a sheet under the focused one, are refused with nothing sent.

Decisions:
- Only `AXSheet`s take the keys. A focused popover or child window that is not a sheet (an Electron child `BrowserWindow`, say) still gets the refusal, so takeover never sends keys meant for the parent into it.
- A control's keys follow only when it is drawn in the window holding the focused element, so they never fall back to a takeover the focus check would refuse anyway.
- Pointer input already works this way: a click where an attached sheet is topmost goes to the sheet.

Not in scope: Linux and Windows, which have no sheets.

## Testing

macOS 26.5 VM, TextEdit's Save sheet with Finder in front, so every call is background input unless it says takeover; the same cells on `main` and on this branch:

| Call | main | this PR |
|---|---|---|
| `win.press('cmd+shift+g')` on the document | `InvalidTarget` naming the Save sheet | Go to Folder opens |
| `win.type('~/Desktop')` on the document | `InvalidTarget` naming Go to Folder | typed into its field |
| `field.press('enter')` on the Go to Folder field | `InvalidTarget` naming Go to Folder | it closes; Where: reads Desktop |
| `win.press('cmd+shift+g', {takeover: true})` | `InputFailed`: the document cannot become key over its sheet | Go to Folder opens, Finder back in front |
| `textarea.press('x')` on the document under the sheet | `InvalidTarget` | `InvalidTarget`, nothing typed |
| Save As field `.press('a')` while Go to Folder is up | `InvalidTarget` | `InvalidTarget`, nothing typed |

`keys_for_a_window_go_to_the_sheet_focused_on_it` covers `sheet_key_target`'s branches (nested sheets, a non-sheet child, controls drawn in each window); `cargo test -p pi-natives --lib keys_for_a_window` passes on macOS, and `scripts/rust-check` (clippy, rustfmt) passes on macOS and Linux.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
