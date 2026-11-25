## What

I added the missing `errexit` field to the Windows-only env_cwd test session because `omp-shell`'s library unit tests stopped compiling for Windows when `set -e` tracking landed.

One line in `crates/shell/src/shell/tests/env_cwd.rs`: the `#[cfg(windows)]` `session_with` helper now builds `ShellSessionCore` with `errexit: false`, as the initializer in `create_session_as` does. No code outside that test changes.

## Why

cc3a18faa44 (`fix(shell): reported cwd and set -e resets to the agent`, 2026-11-23) added `errexit` to `ShellSessionCore` and to `create_session_as`'s initializer, but not to this helper, which compiles only for Windows. Since then `cargo clippy --all-targets` and the library test build for `x86_64-pc-windows-msvc` stop at E0063 (missing field `errexit`) in `env_cwd.rs`, so `omp-shell`'s library unit tests do not build on Windows; Linux and macOS targets compile the helper out.

No CHANGELOG entry: nothing a user sees changes.

## Testing

- `cargo xwin clippy --target x86_64-pc-windows-msvc -p omp-shell --all-targets --no-deps` on `main` (4a6030b062b) fails with E0063 at `env_cwd.rs:22`; on this branch it passes, and the workspace-wide `cargo xwin clippy --all-targets` finishes with no errors.

---

- [ ] `bun check` passes (Rust test-only change; not run)
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
