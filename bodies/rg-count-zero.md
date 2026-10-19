## What

Counting matches with the bash tool's `rg -c` gave me a `path:0` line for every file without one, so a count over a repo listed the whole repo, and I've made zero counts print only with `--include-zero`, as ripgrep does.

`rg -c` through the bash tool's in-process `rg` (Linux, median of 5 runs):

| Tree, command | Lines, `main` → this PR | Time, `main` → this PR | ripgrep 14.1 |
|---|---|---|---|
| this repo (9,180 files), `rg -c fn .` | 9,180 → 1,454 | 0.60 s → 0.16 s | 1,455 lines, 0.05 s |
| this repo, `rg -c -F <no match> .` | 9,180 → 0 | 0.24 s → 0.15 s | 0 lines, 0.06 s |
| a checkout with build output (64,170 files), `rg -uu -c -F <no match> .` | 64,170 → 0 | 4.16 s → 0.99 s | 0 lines, 0.25 s |

The remaining gap to ripgrep is that the builtin searches one file at a time (`-j` is accepted and ignored); that is a separate change. `grep -c` still prints zeros, as GNU grep does.

## Why

`RgSink::finish` wrote a count record for every searched file. ripgrep skips zero counts unless `--include-zero` is given (`rg --help`: "print the number of matches for each file even if there were zero matches"), so commands written for real ripgrep came back with one extra line per file, and a large tree turned the result into tens of thousands of lines for the bash tool to stream and truncate. The builtin now checks the count first and accepts `--include-zero` / `--no-include-zero` (last one wins), for both `-c` and `--count-matches`. Exit codes are unchanged: 1 when nothing matched.

## Testing

- `count_skips_files_without_matches_unless_include_zero` (`rg.rs`): `-c` and `--count-matches` over a matching and a non-matching file print only `a:2`; `-c` on the non-matching file alone prints nothing and exits 1; `--include-zero` adds `b:0`; `--no-include-zero` after it removes it again. With the check reverted it fails (`a:2\nb:0\n`).
- Each case checked against ripgrep 15.1 on macOS and 14.1 on Linux.
- Through the bash tool itself (`BashTool.execute`, natives built from `main` and from this branch) on a 7,116-file checkout: `rg -c fn . | wc -l` gives 7,116 on `main` and 1,029 here, median 356 ms → 187 ms.
- `cargo test -p pi-builtins --lib` passes (1,339 tests).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
