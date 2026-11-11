## What

I made Windows computer runs report when the desktop is locked or disconnected so a failed capture or undelivered input is not mistaken for the app's state.

`screenLocked` now includes locked sessions, disconnected sessions and secure desktops such as UAC. Capture failures, tagged screenshots and completed input runs use the existing shared screen-state annotations, with Windows-specific explanations rather than macOS claims.

## Why

Windows always reported an unlocked screen. An unavailable session could leave the agent with only a raw capture error or apparent input success.

The probe combines session state with access to the input desktop, following [Cua PR 5266](https://github.com/trycua/cua/pull/5266). [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w) the lock flags; the Windows 7 inversion does not apply to the supported runtime. Display sleep remains unreported because its notification needs ongoing registration.

Review `win32/session.rs` first, then shared screen-state dispatch and the Windows annotations; macOS retains its existing explanations. Duplicate Windows guide instructions and the run note's retry directive were dropped. Remaining runtime notes only diagnose the unavailable desktop and capture/input evidence limits; capabilities and errors name the condition.

## Testing

- Linux: `cargo test -p pi-natives --lib windows_screen_locked_verdict` fails with the original always-false verdict restored (1 failed), then passes (1 passed).
- `rust-check --windows` (xwin clippy), Linux `rust-check`, and macOS `rust-check`: clippy and rustfmt passed.
- `bun test packages/coding-agent/test/tools/computer.test.ts`: 146 passed. The Windows notice regression fails when either its capture annotation or run-state branch is reverted, and passes applied; macOS explanations remain covered.
- Precheck's behavior NOTE covers the two runtime templates: the Windows arms contain condition facts, not new behavioral instructions. No model-efficacy claim is made.

Live check on a Windows 11 guest, the console session locked with `LockWorkStation`, then `capabilities()`, a screenshot and a background `type("x")` into a Win32 window:

| after locking | `main` | this PR |
|---|---|---|
| `capabilities().screenLocked` | `false` | `true` |
| `screenshot()` | `CaptureFailed: ... The handle is invalid` | same error, tagged "(the screen is locked)", plus the run's lock note |
| `type("x")` | success | `InputFailed`: no input was sent (the screen is locked) |

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
