## What

An agent ran `rustfmt --check` on one file and the bash tool told it `5 files reformatted`, so I made the summary count files instead of diff locations, and say they need formatting, since `--check` doesn't change anything.

A check of two files, one with 300 unformatted spots, went from `301 files reformatted` to `2 files need formatting`:

```text
main                                     this PR
301 files reformatted:                   2 files need formatting:
  …/live/src/x.rs:1                        …/live/src/x.rs
  …/live/src/x.rs:7                        …/live/src/y.rs
  …/live/src/x.rs:16
  […298 files elided…]
```

## Why

The bash tool's output minimizer condenses large `rustfmt --check` output into a file list (`rust_tools.rs`, `collect_diff_files`). It parsed the old `Diff in <path> at line <N>:` header, but current rustfmt (1.8.0 here) prints `Diff in <path>:<N>:` once per diff location. The filter kept `:<N>` as part of the path, so each location counted as its own file. It now drops a trailing `:<N>` only when `N` is a number, so Windows drive colons and colons inside a path stay put, and it still reads the old form.

The header said `reformatted`, but every rustfmt mode that prints `Diff in` only compares (`--emit stdout` prints source, not diffs), so it now says `need formatting`, the wording the Prettier filter already uses.

Non-goal: `cargo fmt --check` goes through the cargo filter, which this leaves alone.

Maintenance: if rustfmt changes the header again, paths show a suffix again; `rustfmt_counts_files_not_diff_locations` is built from real 1.8 output and is where to update it.

## Testing

- Live on Linux, rustfmt 1.8.0: `rustfmt --check src/x.rs src/y.rs` (59 KB of diff, 300 locations in `x.rs`, one in `y.rs`) through `executeShell` with the minimizer on, once with a `main` natives addon and once with this branch's. Output above.
- `cargo test -p pi-shell --lib minimizer::filters`: 657 passed. With the `rust_tools.rs` change reverted and the tests kept, `rustfmt_counts_files_not_diff_locations` and `rustfmt_diff_output_compacts` fail.
- Not run: a Windows path live; the parse keeps `C:\p\x.rs` by construction (only a numeric last segment is dropped).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
