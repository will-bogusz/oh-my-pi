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

## Verification

- Linux and macOS: `rust-check` (clippy and rustfmt) passed.
- Windows cross-build: `rust-check --windows` (xwin clippy and rustfmt) passed.

Live check on a Windows 11 desktop: pending.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution
