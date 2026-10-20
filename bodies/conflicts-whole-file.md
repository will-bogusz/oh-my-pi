## What

Follow-up to #16269: I made `read <path>:conflicts` scan the whole file, because on files over 10 MiB it stopped at the first 10 MiB and told agents a file had no conflicts when they all sat past that point.

| `read <path>:conflicts` on a file over 10 MiB | `main` | This PR |
|---|---|---|
| One block at line 110001 of an 11 MiB file | `No unresolved git merge conflicts in after-cap.ts.` | `1 unresolved conflict` with `#1  L110001-110005`, registered |
| A block at L1-5, then one opened at L104000 that closes past 10 MiB | `1 unresolved conflict`, plus `file scan hit the byte cap; additional conflicts may exist beyond the scanned prefix` | `2 unresolved conflicts`, both registered |

The per-read conflict count (the `⚠ 3 of 6 visible` warning on an ordinary ranged read) keeps its 10 MiB cap.

## Why

#16269's `Conflict #N not found` error sends agents to `<path>:conflicts` to register the blocks a ranged read did not show. Past 10 MiB that advice led back to the same error: the selector registered nothing there, and with no block in the first 10 MiB it printed the plain "no conflicts" line without its cap note.

Decision: scan to the end instead of telling the agent how to reach the rest. A first version named the line the scan stopped at and asked for a range read from there; the review found that a ranged read registers only blocks it shows whole, so a block split across two read pages stays unregistered, and a 50 MiB file means hundreds of pages. `scanFileForConflicts` now streams the file line by line through a `ConflictScanner` (the old `scanConflictLines` loop, holding its state between lines), and `:conflicts` passes no cap. `scanConflictLines` keeps its signature and stays the window scanner.

**Cost:** time and memory grow with the file instead of stopping at 10 MiB. On goliath a 191 MiB file with one block at the end scans in 163 ms with +36 MB RSS. The worst case is a `<<<<<<<` that never closes: the scanner keeps the lines after it until the next opener, +491 MB RSS for the same file with a stray opener on line 1. The scan checks the read's abort signal between chunks.

## Testing

- New `conflict-integration.test.ts` case: the two files in the table get the listings above, and `read conflict://1/theirs` renders the block found past 10 MiB. `bun test test/tools/conflict-integration.test.ts test/tools/conflict-detect.test.ts`: 105 pass, the existing scanner cases included.
- Negative controls: with `src/tools` reverted to `main` the case fails (`Received: "No unresolved git merge conflicts in after-cap.ts."`); with `:conflicts` passing the default cap again it fails the same way.
- `bun run check` in `packages/coding-agent` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
