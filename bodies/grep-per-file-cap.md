## What

My agents kept treating grep's first 20 hits in a file as all of them, because the cut was only shown in the TUI, so I made the result tell the model which files were trimmed and how to get the rest.

On capped searches Haiku 5.5 now finishes in 2.3 tool calls instead of 4.0 (n=16 vs 32, permutation p<0.001); searches that hit no cap are unchanged at 2.6.

grep keeps the first 20 matches of each file when it searches several files, and the first 200 in a single file. When a cap bites, the result now ends with:

```
More than 20 matches in src/events.ts; grep keeps the first 20 per file when searching several. Search one file alone for up to 200.
```

or, for one file, ``More than 200 matches; grep keeps the first 200 in a file. Add a line range (`path:N-M`) or narrow the pattern for the rest.`` Only files the result shows with a full 20 are named (up to five, then a count), and the line sits outside the 50 KB output cap so a long result cannot cut it off.

**Beyond the notice:** on `main` the per-file cap also set the native limit flag, so the page line read `Showing files 1-20 of 26+` after a walk that had seen all 26 files. The `+` now appears only when native grep stops at its 2,000-match total; dropping this is one line in `grep.ts`.

## Why

The TUI renders "first 20 matches per file" from `details.perFileLimitReached`; the model's text carried nothing, so an agent listing call sites got 20 and stopped, or re-searched. In my sessions since 2026-09-20, 1,560 of 24,164 grep calls (6.5%) hit a cap, and the next three calls went back to a capped file 39% of the time against 22% for files with 10-19 matches.

Decisions:
- A trailing line, like the existing `Showing files …` line, rather than a count in each file header: one place to look, and nothing changes when no cap bites.
- Giving files named one by one the 200 cap did no better in the same runs (2.6 vs 2.6 calls) and made results longer, so it is not here.

## Testing

Live: `omp -p` with `anthropic/claude-haiku-5-5`, thinking low, on a fixture repo whose `src/events.ts` has 35 `emit(` calls (non-sequential names) next to small files. T1 asks for every event name under `src/`, T2 for those in `src/events.ts;src/a.ts`, T3 is T1 with 12 calls (no cap). Two separate `main` batches give the noise.

| Task | `main` calls (n=16) | this PR (n=8) | correct |
|---|---|---|---|
| T1 directory | 4.38 | 2.38 | 15/16; 8/8 |
| T2 two files | 3.56 | 2.12 | all |
| T3 no cap | 2.62 | 2.62 | 15/16; 7/8 |

Misses on T3 are unrelated to the cap. `gpt-6.1-sol` (n=4 per task, earlier wording) reads the file itself either way: 2.1 → 2.0 calls, all correct.

- `test/tools/grep-pagination.test.ts`: exact `of 26` label; the trimmed file named on page 2, and searched alone with no notice; the single-file notice, none for `big.txt:201-250`; the notice kept when 500-byte lines hit the byte cap; no file named under a total limit of 1 (Cursor's `pi_grep`); `and 1 more file` past five. With `grep.ts` reverted, all five fail.
- The harness case grepping 5,000 lines of one file, flagged as silently truncated on `main`, passes.
- `bun test` over the grep test files and `cursor-exec.test.ts`: 179 pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
