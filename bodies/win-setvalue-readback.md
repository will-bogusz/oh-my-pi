## What

I made Windows value writes check what the app kept, and native combo-box changes notify the app instead of just changing their shown text.

| Target | Now |
| --- | --- |
| Text field | Success requires exact readback; rewritten or unreadable values report an error, without exposing secure text. |
| Native combo box | Selecting an exactly matching item or editing its text notifies the app and checks the resulting value; selections also check the index. |

## Why

UI Automation can accept a write that an app reformats or ignores. In WinForms combo boxes, text can change without firing the app's selection handler, so reading the text alone is not enough.

Native Win32 and WinForms combos use background control messages and parent notifications; framework/browser combos retain UI Automation. Owner-drawn combos without strings and `ComboBoxEx32` refuse with a press/click alternative. The native notifications follow [Cua PR 4774](https://github.com/trycua/cua/pull/4774).

## Testing

On Linux, `cargo test -p pi-natives --lib desktop::win32::value_write::tests`: four pure tests fail when routing, readback, planning and exact-case decisions are disabled; all four pass with those decisions restored. They exercise empty-value priority, legacy fallback, secure errors, disabled and unlisted combos, and case-insensitive candidate rejection without creating windows or sending desktop input.

On Windows, `editing_an_unlisted_value_clears_the_previous_selection` opens a real editable combo box, selects an item, then writes text that matches no item: it fails without the selection reset (index stays `1`, expected `-1`) and passes on this branch.

## Verification

- Linux and macOS: `rust-check` (clippy and rustfmt) passed.
- Windows cross-build: `rust-check --windows` (xwin clippy and rustfmt) passed.

Live check on a Windows 11 guest, a WinForms form, one `setValue` per control, the app's own change events logged:

| `setValue` | `main` | this PR |
|---|---|---|
| DropDownList combo to `gamma` | success, the app saw no event | success, the app's selection handler fired (index 2) |
| Editable combo to listed `green` | success, no event | success, selection handler fired (index 1) |
| Editable combo to unlisted `purple` | success, no event | success, text handler fired, selection cleared (index -1) |
| Uppercasing text box to `abc` | success, the field reads `ABC` | `AxFailed`: wrote "abc", the field now reads "ABC" |
| Plain text box | success | success, same |

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution
