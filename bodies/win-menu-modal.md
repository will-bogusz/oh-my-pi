## What

I fixed Windows menu selections reporting failure when the command has already opened a modal dialog.

The attached Win32 menu path recognizes a new responsive dialog owned by the target, on its thread, while the target is disabled. It considers all new windows, so an existing palette cannot hide the dialog. Missing window observations disable only recovery, not ordinary command delivery. UI Automation menus and command-ID, path and enabled-state checks are unchanged.

## Why

Commands such as File > Open run the dialog's message loop inside their handler, so synchronous delivery times out while the dialog is open. Keep synchronous delivery rather than posting commands: queue acceptance or a responsive app does not establish that the command ran. Recovery requires a new visible, enabled owned window that responds, and a disabled owner; hung apps retain the uncertain-delivery error.

## Testing

The modal regression failed with the original send-only verdict restored. Restoring the fatal-snapshot and first-popup behavior fails 2 regression tests; with all fixes applied, all 3 tests pass. Controls reject missing observations, existing or unrelated popups, enabled owners and unresponsive dialogs.

## Verification

- Linux: `cargo test -p pi-natives --lib desktop::win32::menu_delivery`.
- Linux `rust-check` and Windows `rust-check --windows`: clippy and rustfmt passed and recorded on the final head. Windows uses cargo-xwin with all test targets compiled.
- Live check on a Windows 11 guest: a classic Win32 probe window whose File > Dialog... opens a modal MessageBox, `win.menu.select(["File", "Dialog..."])` in the background. On `main` it threw `AxFailed: native menu command delivery failed or timed out and may already have taken effect` after 1533 ms while the dialog was open; with this PR it returned success after 1517 ms with the dialog open, and the user's window kept the foreground in both.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution
