## What

Asking `read` for a slice of a macOS `sample` report gave my agents lines from omp's generated summary instead of the file, so they re-read everything with `:raw` and any edit from those lines bounced as stale; ranges and tails now read the file itself.

On the 9 recorded range and tail reads of real `.sample.txt` reports, replayed through `read`: **0/9 → 9/9** return the file's lines with the file's snapshot tag.

`read demo.sample.txt:9-11` (a 26-line report):

```text
main                                           this PR
[demo.sample.txt#8D13]   ← summary's tag       [demo.sample.txt#2C9F]   ← the file's tag
8:    90 100.0%  start (dyld) › run            8:Call graph:
9:    70  77.8%    boxm [recursive ×2]         9:    100 Thread_1: main
10:   10  11.1%      memcpy (libsystem…)       10:    + 100 start  (in dyld) + 8  [0x100]
…                                              …
```

On `main`, an edit anchored on `#8D13` is rejected with "file changed between read and edit … the current file hashes to #2C9F", though nothing changed the file. `.cpuprofile` files go through the same branch and had the same defect.

| Read of a `.sample.txt` / `.cpuprofile` | `main` | this PR |
|---|---|---|
| `:N-M`, `:N`, multi-range, `:-N` | slices of the summary; past its end, "beyond end of profile summary" | the file's lines and tag |
| bare path | summary with row numbers and a hashline header; over 50 KiB, a `Use :N to continue` into the summary | summary as plain text; over 50 KiB, cut with the full summary in an artifact |
| `:raw`, `:raw:N-M` | the file | unchanged |

## Why

The summary (`utils/sample-profile.ts`, `utils/cpuprofile.ts`) replaces a 10k-line call tree on a plain read, but `read.ts` applied it to every non-`:raw` selector. Line numbers an agent asks for come from the file (`grep`, an earlier `:raw` read, a stack trace): summary line 9 is not file line 9, and summary line 1435 does not exist.

Decisions:
- Only a bare-path read (`parsed.kind === "none"`) summarizes; the footer now says a line range reads the original.
- Once `:N` means a file line, nothing on the summary may look addressable: no row numbers, snapshot header, `:N` continuation, or `totalLines` (which also let it supersede earlier range reads as a "complete" read). An oversized summary is cut with `enforceInlineByteCap` into an artifact, as the `ida` tool does. Falling back to the raw report would give a huge call tree's first page to the reads the summary is for.

Non-goals: summary content, the 32 MiB cutoff.

## Testing

- `test/sample-profile.test.ts`, `test/cpuprofile.test.ts`: a range and a tail return the file's lines and an edit with their tag applies; a whole-file summary has no snapshot header or row numbers (`readLineNumbers` on); a summary over 50 KiB is cut with the full text in the artifact and no `:N` hint. `test/read-supersede-prune.test.ts`: a bare read no longer prunes an earlier range read. **Negative control:** with `read.ts` reverted, 7 of 31 tests fail.
- Replay: the 21 `read` calls on `.sample.txt` reports in my session history (10-04 to 10-07, 5 reports of 850 to 8,146 lines, one project, GPT models), run through `ReadTool` and `EditTool` from `main` and this branch on the same files:

  | 9 non-`:raw` selector reads | `main` | this PR |
  |---|---|---|
  | output identical to the same selector on a plain `.txt` copy | 0 | 9 |
  | header tag equals the file's tag | 0 | 9 |
  | one-line edit from that read applies | 0 (7 stale, 2 no rows) | 9 |

  The 12 `:raw` reads are identical on both. In the recorded sessions, 8 of those 9 reads were followed by a `:raw` re-read of the same lines.
- `bun run check` (package) and root `check:ts` pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
