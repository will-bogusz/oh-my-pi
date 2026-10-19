## What

`write` ate the addresses off a two-line disassembly I had an agent save (`100000000: 30 00 …`, `100000004: c0 03 …`), because it took every leading `N:` as a line number copied from `read`; now it only strips numbers that count up the way `read` prints them.

On 9,313 texts replayed through the strip function, multi-row data files it stripped went from 36 to 0, while every `read` and `grep` echo it stripped is still stripped.

| Content written in hashline mode | `main` | This PR |
|---|---|---|
| Copied `read`/`grep` rows: `1:a`, `2:b`, `…`, `9:c` | stripped | stripped |
| Disassembly: `100000000: …`, `100000004: …` | addresses deleted | kept |
| Timestamped log or transcript: `20:56:07 read a`, `20:56:07 read b` | `20:` deleted from every row | kept |
| `strings -t d` style offsets: `660:…`, `5821:…` | offsets deleted | kept |
| One row (`16:49 up 45 days`) | stripped | stripped (unchanged) |

## Why

`strip_hashline_prefixes` (the `write` tool's prefix cleanup, through `stripWriteContent`) stripped whenever every content row started with digits and `:` or `|`. That shape is common in real data. `read` and `grep` number rows one apart and mark every skip with a blank, `…`/`...` or header row, so the new check (`numbers_count_up_by_one`) accepts a jump only right after one of those rows.

Decisions:
- Partial views that skip rows with no marker, edit previews (`1287:` then `1336:`) and `ast_grep` matches, are no longer stripped when pasted whole into `write`. Such text is not the file either way: stripped, it silently writes a file missing rows; unstripped, the visible prefixes show the mistake on the next read.
- Single rows keep `main`'s behaviour: one row gives nothing to count.
- `conflict://*` per-id directives copied behind line numbers (`40:#1 = @ours`, `45:#2 = @theirs`) used to parse only because the cleanup stripped them; `BULK_DIRECTIVE_RE` now accepts that prefix itself, so they still resolve per id instead of pasting the text into every block.

Non-goal: numbered content that does count up by one (`1: first item`, `2: second`) is still stripped, as on `main`.

## Testing

- `cargo test -p pi-edit`: passes. `write_prefix_strip_keeps_numbers_that_do_not_count_up_by_one` (`tests/hashline_parse.rs`) fails on `main`; the negative control `write_prefix_strip_still_removes_read_and_search_numbering` (read rows across a `…` gap, grep `*N:`/` N:` rows across `...` and two file headers) passes on both.
- Replay, `main` vs this PR, through the Rust function: 2,400 `read`/`grep`/`edit` results from my sessions since 10-01, whole and in random windows. `main` strips 1,297 read and 1,951 grep texts, this PR all of them; edit previews 3,060 → 2,619, the difference being previews that skip rows. Data files on disk `main` would strip: 36 multi-row → 0, 11 single-row unchanged. Nothing is stripped that `main` keeps.
- Recorded "auto-stripped" `write` results in my sessions: 3. The disassembly is no longer stripped; two `conflict://*` writes with rows 2–3 and 13–16 still are.
- `WriteTool` end to end with this branch's native addon (`bun test test/write-hashline-header.test.ts test/tools/conflict-integration.test.ts`, 48 pass): the disassembly is written byte for byte with no "auto-stripped" note, copied `1:`/`2:` rows still strip, and `40:#1 = @ours` / `45:#2 = @theirs` resolve per id; that last test fails with the `BULK_DIRECTIVE_RE` change reverted. `bun run check` in `packages/coding-agent` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
