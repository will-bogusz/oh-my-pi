## What

Agents kept asking `read` for the top and bottom of a file in one call, like `manifest.json:1-30,:-30`, and got the top plus a "path not found" for the tail, so I made comma lists accept the tail chunk.

Recorded head+tail reads go from 0 of 8 fully served to 8 of 8.

| `read` path | main | this PR |
|---|---|---|
| `file:1-30,-30` | lines 1-30, then `Could not read -30: Path '-30' not found` | lines 1-30 and the last 30 |
| `file:1-30,:-30` (also with `:raw` before or after) | lines 1-30, then `Path ':-30' not found` | lines 1-30 and the last 30 |
| `artifact://N:1-12,-15` | `artifact:// ID must be numeric, got: N:1-12,-15` | lines 1-12 and the last 15 |

A `-N` chunk in a comma list means the last N lines, as `:-N` does alone. A bare `N` beside it stays that one line, as in any comma list, and the tail merges with the listed ranges like any overlapping ranges.

## Why

`:-N` and comma lists are both documented, but the path splitter only peeled lists of ranges. A list holding a tail fell through: a local path was split at the comma into a second, missing file, and an internal URL kept the selector in its id. The output names the failed part, yet in 6 of the 7 local cases the agent moved on without the tail.

Decisions:
- `,:-N` (7 of the 8 recorded calls) reads as `,-N` instead of failing. An existing file whose name ends where the repeated colon starts (`a:1-30,` read with `:-30`) still wins, as literal names do everywhere else in `read`.
- The parsed selector stays `kind: "tail"` with the listed ranges attached, so every consumer still pins it with `resolveTailSelector` before slicing, which `ResolvedSelector` enforces. Directory and archive-directory listings reject it like any multi-range selector.
- The tool prompt is unchanged.

Not covered: `:raw` repeated per range inside a list (`:70-72:raw,610-612:raw`) still splits; `:raw:70-72,610-612` is the documented form (1 recorded call).

Review first: `parseRangeOrTail` and `resolveTailSelector` in `tools/read-selector.ts`, then `foldRepeatedListColons` and `splitPathAndSel` in `packages/tui/src/tools/read.ts`.

## Testing

- Replayed the 66,350 `read` paths recorded in my sessions since 10-01 through `splitPathAndSel`, `splitInternalUrlSel` and `parseSel` on `main` and on this branch: exactly the 8 head+tail paths change (3 sessions, 10-06 to 10-09), none of the other 66,342.
- Ran those 8 reads end to end through `ReadTool` on fixtures with the recorded line counts: 0/8 return every requested line on `main`, 8/8 here.
- `bun test test/tools/read-head-tail-list.test.ts`: merges (open-ended and past-EOF ranges kept), both spellings with `:raw` on either side for a file and an `artifact://`, a literal `a:1-3,` file, and a 6,400-chunk list (0.3 ms). 12 of its 13 tests fail on `main`'s source; the literal-file test passes there and fails with only the literal check removed. The existing selector and path-list suites (15 files, 219 tests) pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
