## What

I made `masks` build on Windows again, because `main` no longer compiles for Windows: `text_readback` calls it on every platform, but it was compiled only for macOS, Linux and tests.

The change deletes the `#[cfg(any(target_os = "macos", target_os = "linux", test))]` on `masks` in `crates/pi-natives/src/desktop/ax.rs`, nothing else. `masks` is reachable on all three platforms through `text_readback`, so it needs no dead-code allowance.

## Why

#19026 (mine) moved `masks` next to `masked` with a cfg matching the platforms that called it at the time; #18915 had already made `text_readback` the Windows value-write verdict (`win32/value_write.rs`, `verdict` and `combo_verdict`). Once both were on `main`, a normal Windows build of `pi-natives` fails with E0425, cannot find `masks`. #19026's checks ran on macOS and Linux only, which is how it got through.

## Testing

- `cargo xwin check -p pi-natives --lib --target x86_64-pc-windows-msvc` (a non-test build): fails on `main` 7c2ab113ec9 with E0425, cannot find function `masks` in `text_readback` (`desktop/ax.rs`), and passes on this branch.
- `scripts/rust-check` (clippy `--all-targets`, rustfmt) passes on Windows through cargo-xwin, Linux and macOS.
- `cargo test -p pi-natives --lib desktop::ax`: passes on Linux (46) and macOS (47).

---

- [ ] `bun check` passes (no TypeScript changes)
- [x] Tested locally
- [ ] CHANGELOG updated (no entry: the break never shipped in a release)
