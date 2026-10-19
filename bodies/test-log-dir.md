## What

Running omp's own test suites was quietly filling my real `~/.omp/logs` with fake warnings and errors, so test processes now get a logs dir under the temp dir instead.

A suite run used to add about 6,250 lines (72 errors, 1,470 warnings) to the developer's real logs dir; with this PR the test processes add none, and `cargo test` panics stop leaving `native-panic-*.log` files there.

| Same suites, `HOME` and `TMPDIR` at a sentinel | `main` (3 runs) | this PR (2 runs) |
|---|---|---|
| Lines in `~/.omp/logs` from test processes | 6,219-6,226 | 0 |
| Lines in `~/.omp/logs` from probes the tests spawn | 25 | 19 |
| Lines in `<tmpdir>/omp-test-logs` | none | 6,265-6,343 |
| `native-panic-*` files in `~/.omp/logs` after the Rust tests below | 1 | 0 |

- **Bun:** when `isBunTestRuntime()` is true, `getLogsDir()` returns `<tmpdir>/omp-test-logs`, so the logger, `getLogPath()`, the stderr guard's fallback and report bundles keep agreeing. `isBunTestRuntime` moves to a side-effect-free `test-runtime.ts` (re-exported from `env.ts`) so `dirs.ts` can use it without loading `.env` files.
- **Rust:** the `pi-natives` unit-test build (`cfg!(test)`) writes crash reports to `<tmpdir>/pi-natives-test-logs`.

Non-goals: a probe a test spawns with the test's env (the 19 lines) still logs to its `HOME` under a plain `bun test`; under `bun run test` it inherits `PI_TEST_RUNTIME=1` and follows. `NODE_ENV=test` alone stays non-test (#7261).

## Why

On my Mac since 2026-10-14, lines from `bun test` processes (they log in UTC, real omp in local time) were 35% of the warnings and 68% of the errors in `~/.omp/logs`, and 334 of its 335 `native-panic-*` files came from Rust test threads. That buries real diagnostics, and `omp report` bundles same-day logs.

Not a bunfig `[test] preload`: the root `bunfig.toml` isn't read when `bun test` runs from a package dir, where every `test` script runs. `isBunTestRuntime()` is already how the repo keeps tests off user state (`http-inspector`'s dumps into the logs dir, the composer and judgment caches). Related: #14013 tried a HOME-redirect preload.

## Testing

- New `logger-contract.test.ts` case: the `default-file` probe runs with `PI_TEST_RUNTIME=1` and its own `TMPDIR`/`TMP`/`TEMP`; the child's `HOME` stays empty, the record lands in `<tmp>/omp-test-logs`, and its `getLogPath()` names that file. Fails on `main` (`HOME` gains `.omp`).
- New `crash_handler` test: `crash_log_path` resolves under `temp_dir()/pi-natives-test-logs` for both crash kinds; fails with the fix reverted.
- Rows 1-3: utils, agent, ai, tui and a coding-agent subset (`agent-session*`, `session-*`, `test/session`, `test/debug`, `test/task`) under `bun test --parallel`, counting `omp.*.log` lines under the sentinel. Pass/fail counts match between arms.
- Row 4: `cargo test -p pi-natives --lib -- vcs:: oauth_callback:: crash_handler:: task:: --skip desktop` on macOS (desktop tests drive the host's input, not run).
- `check:types` (utils, coding-agent), oxlint, oxfmt, rustfmt; clippy reports nothing in `crash_handler.rs`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
