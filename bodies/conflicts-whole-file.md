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

**Cost:** time grows with the file; memory does not. The scan keeps at most 10 MiB of one line (enough to match any marker) and 10 MiB of one block's sections: a block past that is dropped and named in the listing (`not listed (over 10 MiB of sections; resolve with a normal edit): conflicts opened at L1.`), so a `<<<<<<<` that never closes cannot hold the rest of the file. On goliath, 191 MiB files scan in 74-163 ms with a peak of +77 to +81 MB RSS whether they hold one block at the end, a stray opener on line 1, or a single 191 MiB line. The scan checks the read's abort signal between chunks.

## Testing

- New `conflict-integration.test.ts` cases: the two files in the table get the listings above, and `read conflict://1/theirs` renders the block found past 10 MiB; a block whose `ours` holds 11 MiB is named in the note while the block after it is still listed; a 12 MiB line with no newline before a block still lets that block be listed. `bun test test/tools/conflict-integration.test.ts test/tools/conflict-detect.test.ts`: 106 pass, the existing scanner cases included.
- Negative controls: with `src/tools` reverted to `main` the first case fails (`Received: "No unresolved git merge conflicts in after-cap.ts."`); with `:conflicts` passing the default cap again it fails the same way; with the block-size check disabled the second case lists the 11 MiB block (`⚠ 2 unresolved conflicts`).
- `bun run check` in `packages/coding-agent` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
