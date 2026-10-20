## What

Follow-up to #16269: I made `read <path>:conflicts` scan the whole file, because on files over 10 MiB it stopped at the first 10 MiB and told agents a file had no conflicts when they all sat past that point.

| `read <path>:conflicts` on a file over 10 MiB | `main` | This PR |
|---|---|---|
| One block at line 110001 of an 11 MiB file | `No unresolved git merge conflicts in after-cap.ts.` | `1 unresolved conflict` with `#1  L110001-110005`, registered |
| A block at L1-5, then one opened at L104000 that closes past 10 MiB | `1 unresolved conflict`, plus `file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix` | `2 unresolved conflicts`, both registered |

The per-read conflict count (the `⚠ 3 of 6 visible` warning on an ordinary ranged read) keeps its 10 MiB cap.

## Why

#16269's `Conflict #N not found` error sends agents to `<path>:conflicts` to register the blocks a ranged read did not show. Past 10 MiB that advice led back to the same error: the selector registered nothing there, and with no block in the first 10 MiB it printed the plain "no conflicts" line without its cap note.

Decision: scan to the end rather than tell the agent how to reach the rest. A first version named the line the scan stopped at and asked for a range read from there, but a ranged read registers only blocks it shows whole, so a block split across two pages stays unregistered. `scanFileForConflicts` now frames lines with the shared `ConcatSink.appendAndFlushLines()` (new `maxLineBytes` limit in `pi-utils`) into a `ConflictScanner`, the old `scanConflictLines` loop holding its state between lines (`readLines()`'s async yield per line was 1.7x slower).

**Cost:** time grows with the file; memory stays bounded. The scan keeps at most 10 MiB of a line, and 10 MiB of file bytes of conflict sections per file across all blocks; a block that would pass it is dropped and named (`not listed (the scan keeps at most 10 MiB of conflict sections per file; resolve these with a normal edit): conflicts opened at L1.`). On goliath, 191 MiB files take 57-348 ms and peak at +77 to +124 MB RSS (block at the end, stray opener on line 1, one 191 MiB line, 191 one-MiB blocks); the worst shape, a stray opener then 191 Mi empty lines, takes 21 s and peaks at +303 MB. The scan checks the abort signal between chunks.

## Testing

- New `conflict-integration.test.ts` cases: the two files in the table get the listings above, and `read conflict://1/theirs` renders the block found past 10 MiB; a block holding 11 MiB, one holding 11 Mi empty lines, the second of two 6 MiB blocks, and one holding an 11 MB line of `€` are each named in the note while the block after is listed; a 12 MiB line before a block still lets that block be listed. `bun test test/tools/conflict-integration.test.ts test/tools/conflict-detect.test.ts`: 107 pass. New `stream.test.ts` case: `appendAndFlushLines` with `maxLineBytes: 4` keeps 4 bytes of each line across chunk splits (45 pass).
- Negative controls: with `src/tools` reverted to `main` the first case fails (`Received: "No unresolved git merge conflicts in after-cap.ts."`), and the same with `:conflicts` passing the default cap again; with the budget check disabled, line breaks not counted, completed blocks not charged, or decoded characters charged instead of bytes, the matching case lists the dropped block; with `maxLineBytes` ignored the `stream.test.ts` case fails.
- `bun run check` in `packages/coding-agent` and `packages/utils` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
