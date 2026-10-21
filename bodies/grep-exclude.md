## What

My agents kept paging through vendored and generated hits, or dropping to `grep -v` in bash, because grep could not leave a folder out, so a `path` entry starting with `!` now excludes matching files and folders.

```
grep pattern=FEATURE_X path=".;!vendor;!gen"
grep pattern=track\( path="src;!*.test.ts"
```

`!*.test.ts` drops matching files at any depth, `!vendor` that folder anywhere, `!src/legacy` only that one. With only `!` entries the search covers `.`; a real file named `!notes.txt` is still searched. Where vendored hits filled the first page, Haiku 5.5 went from 3.6 tool calls to 1.1 (n=16 vs 8), all correct.

On `main` a `!` entry was taken as a path and matched nothing; in one of four runs there `gpt-6.1-sol` wrote `.;!vendor/**;!gen/**` unprompted and got vendor back.

## Why

Since 2026-10-01, 944 of 6,269 recursive bash greps in my sessions (15%) cut paths out (`| grep -v test`, `rg -g '!…'`, `--exclude-dir`).

Decisions:
- `!` entries in `path` rather than a new `exclude` field: both scored 1.0 calls on the vendor task; this adds no schema field and is the `!` of `rg -g` and `.gitignore`.
- In the walker, not on results: excluded folders are never entered, so they never count toward the 2,000-match total or the per-file cap. Filtering results (the first prototype) scored the same but still searched all of `vendor/`.

## Testing

Live: `omp -p`, `anthropic/claude-haiku-5-5`, thinking low, fixture repo. E2: files reading `FEATURE_X` outside `vendor/` and `gen/` (vendored hits fill the first page); E1: non-test files calling `track(` (one page); E3 needs no exclusion. Two `main` batches give the noise.

| Task | `main` calls (n=16) | this PR (n=8) | correct |
|---|---|---|---|
| E2 vendor/gen | 3.56 | 1.12 | all |
| E1 skip tests | 1.00 | 1.00 | 15/16; 8/8 |
| E3 control | 1.31 | 1.38 | all |

`gpt-6.1-sol` on E2: 3.0 → 1.0 calls (n=4 vs 3; one run lost to Codex capacity), all correct.

Replay: 43 recorded bash greps over this repo that exclude paths, re-run on `origin/main` with real `grep`/`rg` and with the new option: 41 return the same files; the 2 others are `grep -v .test.`, whose regex dots also drop `attestation.ts`.

- `test/tools/grep-exclude.test.ts`: exclusions; `!src/legacy` and `!./gen` anchored to cwd; `!`-only lists; a real `!notes.txt` searched and keyed for approval while exclusions grant nothing. Four of five fail with `main`'s `grep.ts`.
- `grep_exclude_drops_matching_files_and_directories` (`pi-natives`): any-depth, trailing `/`, under a `glob`, `/vendor` anchored. Fails without the filter or the anchor.
- `bun test` over the grep test files and `cursor-exec.test.ts`: 180 pass; `cargo test -p pi-walker` and `pi-natives grep::` pass; rust-check on Linux, Windows, macOS.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
