## What

Follow-up to #16269: I made `read <path>:conflicts` scan the whole file, because on files over 10 MiB it stopped at the first 10 MiB and told agents a file had no conflicts when they all sat past that point.

| `read <path>:conflicts` on a file over 10 MiB | `main` | This PR |
|---|---|---|
| One block at line 110001 of an 11 MiB file | `No unresolved git merge conflicts in after-cap.ts.` | `1 unresolved conflict` with `#1  L110001-110005`, registered |
| A block at L1-5, then one opened at L104000 that closes past 10 MiB | `1 unresolved conflict`, plus `file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix` | `2 unresolved conflicts`, both registered |

The per-read conflict count (the `⚠ 3 of 6 visible` warning on an ordinary ranged read) keeps its 10 MiB cap.

## Why

#16269's `Conflict #N not found` error sends agents to `<path>:conflicts` to register the blocks a ranged read did not show. Past 10 MiB that advice led back to the same error: the selector registered nothing there, and with no block in the first 10 MiB it printed the plain "no conflicts" line without its cap note.

Decision: scan to the end rather than tell the agent how to reach the rest. A first version named the line the scan stopped at and asked for a range read from there, but a ranged read registers only blocks it shows whole, so a block split across two pages stays unregistered. `scanFileForConflicts` now frames lines with the shared `ConcatSink.appendAndFlushLines()` (new `maxLineBytes` limit in `pi-utils`) into a `ConflictScanner`, the old `scanConflictLines` loop holding its state between lines. `readLines()` frames the same way but its async yield per line took 582 ms against the sink's 334 ms on 191 MiB.

**Cost:** time grows with the file; memory stays bounded. The scan keeps at most 10 MiB of a line and 10 MiB of a block's sections (line breaks counted); a bigger block is dropped and named (`not listed (over 10 MiB of sections; resolve with a normal edit): conflicts opened at L1.`). On goliath, 191 MiB files take 70-386 ms and peak at +77 to +84 MB RSS (block at the end, stray opener on line 1, one 191 MiB line); the worst shape, a stray opener then 191 Mi empty lines, takes 21 s and peaks at +303 MB. The scan checks the abort signal between chunks.

## Testing

- New `conflict-integration.test.ts` cases: the two files in the table get the listings above, and `read conflict://1/theirs` renders the block found past 10 MiB; a block whose `ours` holds 11 MiB, and one holding 11 Mi empty lines, are named in the note while the block after each is still listed; a 12 MiB line with no newline before a block still lets that block be listed. `bun test test/tools/conflict-integration.test.ts test/tools/conflict-detect.test.ts`: 106 pass, the existing scanner cases included. New `stream.test.ts` case: `appendAndFlushLines` with `maxLineBytes: 4` keeps 4 bytes of each line across chunk splits (45 pass).
- Negative controls: with `src/tools` reverted to `main` the first case fails (`Received: "No unresolved git merge conflicts in after-cap.ts."`); with `:conflicts` passing the default cap again it fails the same way; with the block-size check disabled, or line breaks not counted, the second case lists the dropped block (`⚠ 2 unresolved conflicts`); with `maxLineBytes` ignored the `stream.test.ts` case fails.
- `bun run check` in `packages/coding-agent` and `packages/utils` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
