## What

I made `read` charge a line cut to `tools.outputMaxColumns` the bytes it actually shows, so one long line no longer ends a numbered page after a couple of KB or blocks paging past it.

Over 1,206 recorded long-line reads replayed through `ReadTool`, paging stuck on a line it could not show went from 14 → 0, and lines covered per paging call from 63.1 → 92.6; no read got fewer lines.

A 300-line file whose line 151 is 80 KB, read without a selector:

```text
main                                                  this PR
1:r1                                                  1:r1
…                                                     …
150:r150                                              150:r150
                                                      151:HHHH…(768 columns)…
[Showing lines 1-150 of 300 (48.8KB limit).           152:r152
 Use :151 to continue]                                …
                                                      300:r300
then f.txt:151 shows only line 150 and:               [Some lines truncated to 768 chars.
[Line 151 is 78.1KB and could not fit after            Use :raw:151-151 to read line 151 whole]
 preceding context in the 48.8KB read budget. …]
```

| | `main` | this PR |
|---|---|---|
| bare read of the file above | lines 1-150, 1.2 KB of text | all 300 lines, 151 cut |
| `f.txt:151`, `f.txt:145-160` | stops at 150; only `:raw:151-151` or guessing `:152` moves on | 150-… with 151 cut |
| 35-line JSONL of ~5 KB records | 9 lines per read | 35 lines in one read |
| same file past the 4 MB snapshot cap (streamed) | same refusal | same as the buffered file |

**Beyond the budget:** `write` now refuses content ending in the column-cap notice when it covers less than the file, as it does for `read`'s other truncation notices. Otherwise a 60 KB line, which `main` showed as a byte-capped partial that `write` refused, would now be shown cut and written back cut. `main` has the same gap for lines from 769 bytes up to the budget; this closes it too.

## Why

The page budget (~50 KB) bounds the text a read returns, but numbered reads charged each line its source size while showing at most 768 columns of it: an 80 KB line spent the whole budget to display 771 bytes. `:raw` reads and `tools.outputMaxColumns: 0` are unchanged, and five existing tests now pin the oversized-line notices there. Cut lines stay unseen, so an edit on line 151 is still refused until a `:raw` read.

<details><summary>Decisions</summary>

- Cost is the UTF-8 length of the same `truncateLine` output the display uses, so budget and display cannot drift; only lines longer than the cap cost differently.
- Past the 4 MB snapshot cap the file is streamed, and a long line used to be dropped once it overflowed. It is now kept as a head of at least `3 × cap + 6` bytes, which decodes to more than the cap's columns identically to the whole line (at most 3 bytes per UTF-16 unit, plus a sequence the cut may split). A window holding such a head never builds the whole-file hashline snapshot from its lines (it hashes the file instead, which above 4 MB records no tag, as every other streamed window on `main` does) and never registers a merge-conflict block containing a head; on `main` such a block was never in the window either, so `:conflicts` still registers it.
- A first line is collected when either its source or its cut display fits. Display is wider than source only for stray bytes (each decodes to a 3-byte U+FFFD) or a cap near the budget; then the page ends after that line with `:2` rather than coming back empty.
- Truncation metadata keeps `totalBytes` and the oversized/omitted-line notices in source bytes; `outputBytes` is now the bytes shown.

</details>

Related: #13947 (no column cap for `artifact://` reads), #16024 (empty body for an over-budget first line in JSON reads).

## Testing

`test/read-display-budget.test.ts` (12 cases): buffered and streamed (>4 MB, CJK/emoji heads) reads show all 300 lines cut and `:151` pages through; multi-range; 35-record JSONL whole; no tag from heads; a `:conflicts`-registered 80 KB side survives a numbered read; an overflowing first line pages on. Controls: edit on the cut line refused, `:raw` byte-capped, cap 0 stops at 150. On `main` the 7 budget cases fail, controls pass. `test/write-read-projection.test.ts`: writing back a cut read is refused (accepted without the `write.ts` change).

All `packages/coding-agent` tests: 18,844 pass; the 22 failures (browser, PTY, clipboard, registry) fail on `main` too or pass alone. `bun run check` clean.

Replay of my sessions' numbered reads (10-01..20) that hit the cap or a byte stop, paged by each read's own `Use :N to continue`:

| 1,206 reads (1,150 identical output) | `main` | this PR |
|---|---|---|
| first reads stopped by the byte budget | 24 | 15 |
| paging stuck on a line only `:raw` can pass | 14 | 0 |
| lines covered per paging call | 63.1 | 92.6 |

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
