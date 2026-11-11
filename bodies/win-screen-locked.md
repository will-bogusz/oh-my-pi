## What

I made Windows computer runs report when the desktop is locked or disconnected so a failed capture or undelivered input is not mistaken for the app's state.

`screenLocked` now includes locked sessions, disconnected sessions and secure desktops such as UAC. Capture failures, tagged screenshots and completed input runs use the existing shared screen-state annotations, with Windows-specific explanations rather than macOS claims.

## Why

Windows always reported an unlocked screen. An unavailable session could leave the agent with only a raw capture error or apparent input success.

The probe combines session state with access to the input desktop, following [Cua PR 5266](https://github.com/trycua/cua/pull/5266). [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w) the lock flags; the Windows 7 inversion does not apply to the supported runtime. Display sleep remains unreported because its notification needs ongoing registration.

Review `win32/session.rs` first, then shared screen-state dispatch and the Windows annotations. macOS retains its existing explanations. The new guidance only explains an unavailable Windows desktop; no model trials were run.

## Verification

- Linux: `cargo test -p pi-natives --lib windows_screen_locked_verdict` fails with the original always-false verdict restored (1 failed), then passes (1 passed).
- `rust-check --windows` (xwin clippy), Linux `rust-check`, and macOS `rust-check`: clippy and rustfmt passed.
- `bun test packages/coding-agent/test/tools/computer.test.ts`: 146 passed. The Windows notice regression fails when either its capture annotation or run-state branch is reverted, and passes applied; macOS explanations remain covered.

Live check on a Windows 11 desktop: pending.
