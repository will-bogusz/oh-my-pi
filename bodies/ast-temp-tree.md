## What

The pi-natives ast_edit tests kept failing at random on my Mac because parallel tests were landing in the same temp folder, so I gave each one its own.

On a macOS run of `cargo test -p pi-natives --lib ast::`, failing runs went from 16 of 60 to 0 of 80. Only the `make_temp_tree` test helper in `crates/pi-natives/src/ast.rs` changes; no shipped code does.

## Why

`make_temp_tree` named its directory `pi-ast-glob-test-<nanoseconds since epoch>`. macOS reports `SystemTime` in microseconds, so two of its seven callers running in parallel could get the same name. The first test to finish dropped its `TempTree` and deleted the directory under the other, which then failed with `NotFound` on a file it had just written, or counted the wrong number of searched files.

The name now adds the process id and a per-process counter, the same scheme the `TempDirGuard` helpers in `fd.rs`, `glob.rs` and `grep.rs` already use. `tempfile` is not a pi-natives dependency, and pulling it in for one helper is more than this needs. The other temp-directory helpers in `ast.rs` each have a single caller and their own prefix, so they cannot collide and are left alone.

## Testing

Ran on an Apple-silicon Mac:

| `cargo test -q -p pi-natives --lib ast::`, repeated | Runs with a failure |
|---|---|
| `main` | 16 of 60 (6/20, then 10/40) |
| this PR | 0 of 80 (40 before a comment rewrap, 40 on the head) |

The failures on `main` were `ast_edit_skips_missing_python_token_in_preview_and_apply`, `ast_edit_orders_mixed_language_pattern_warnings` and `ast_edit_strict_parse_failure_does_not_partially_write`. No new test: the existing `ast_edit_*` tests are the regression check, and they fail on `main` as shown above.

`CI=1 bun run check:rs` passes (exit 0).

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
