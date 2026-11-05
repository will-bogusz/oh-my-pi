## What

An agent's `git diff` summary said 10 files changed when there were 12, because the two generated catalog JSONs are marked binary and just vanished, so I made the summary list every file git names, with binary ones as `Bin` like `git diff --stat`.

A diff touching a binary-attributed `models.json`, a binary image, a pure rename and one text file went from 1 file listed to all 4:

```text
main                                     this PR
big.txt | 1200 ++++++++++++------------  app icon.png | Bin
1 file changed, 600 insertions(+), …     big.txt | 1200 ++++++++++++------------
                                         models.json | Bin
                                         new name.txt | 0
                                         4 files changed, 600 insertions(+), …
```

## Why

When a patch is too large to return whole, the bash tool's minimizer replaces `git diff`, `git show` and `diff -u`/`-r` output with a stat-style summary plus sampled hunks (`git.rs`, `compact_diff_output`). `parse_unified_diff` dropped every file without counted `+`/`-` lines, so binary files (in this repo `models.json`, `compat/rules.json` and `defaults.json` are `binary` in `.gitattributes`), pure renames and mode-only changes disappeared from the list and the count, with nothing saying so.

Now every file stays. A file is binary when git prints `Binary files … differ` or a `GIT binary patch` (`--binary`), and `diff -r`'s standalone `Binary files` line starts its own entry. Line-less text changes show `| 0`, as `--stat` does. A diff where no file has counted lines still comes back whole, as on `main`.

Keeping these files exposed how their paths were read, since a text file's `+++` line used to correct them:

- `diff --git a/app icon.png b/app icon.png` was split on whitespace (`icon.png`). A header naming one path twice is now split at its middle, and a rename takes its path from `rename to`.
- `Binary files x/salt and pepper.bin and y/salt and pepper.bin differ` is split where both sides end in the same file name; if no single split does, the whole text is shown rather than a guessed half.

Non-goals: renames still show the new path only (`--stat` shows `old => new`); `diff -r`'s `Only in …` lines and the tab-and-timestamp tail `diff -u` puts on `+++` paths are unchanged.

## Testing

- Live on Linux, through `executeShell` with the minimizer on, `main`'s natives addon against this branch's: `git diff HEAD` in a scratch repo (output above, `git diff --name-status` lists the same 4), `git diff HEAD --binary` (same 4 rows), and `diff -ru x y` with `salt and pepper.bin` beside a 3,000-line text change (`y/salt and pepper.bin | Bin`, 2 files; `main`: 1).
- `cargo test -p pi-shell --lib minimizer::`: 793 passed. With the `git.rs` source change reverted and the tests kept, `diff_lists_files_without_counted_lines` (real git output, paths with spaces) and `diff_output_reuses_unified_diff_compaction` fail.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
