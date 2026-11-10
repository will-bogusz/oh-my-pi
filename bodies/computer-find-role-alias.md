## What

I fixed role searches so native names and common spellings find the same controls without changing the roles printed by `ax()`.

`find({ role: "radiobutton" })` and `find({ role: "AXRadioButton" })` now find a macOS `radio`; `text field` finds `textfield`. Existing printed-role substring matching stays in place, including `button` not matching macOS `radio`.

## Why

The accessibility backends print different names for radio buttons, so a spelling that works on Windows or Linux silently missed the same control on macOS. Role queries now additionally accept an exact native role ignoring case, spaces, `_` and `-`, separator-stripped printed-role queries, and the `radiobutton` alias for `radio`.

Changing the printed vocabulary would also widen existing substring searches. For a macOS `tabgroup` with `radio` children, `tab` still matches only the group: mapping it to `radio` would include unrelated radio buttons. Unknown roles, including separator-only queries, still return an empty array. Review `crates/pi-natives/src/desktop/ax.rs::matches_role` first; a future vocabulary difference needs an explicit alias rather than a printed-role change.

## Testing

- `cargo +nightly-2026-11-08 test -p pi-natives query_accepts_role_aliases_without_widening_printed_substrings`: failed on main plus the regression test (`radiobutton`: 0 matches instead of 1), passed with the fix.
- `cargo +nightly-2026-11-08 test -p pi-natives desktop::ax::tests`: 42 passed on macOS.
- `rust-check`: macOS, Linux and Windows clippy and rustfmt passed on the final head.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (entry added; PR attribution follows creation)
