## What

I changed the partial-window conflict warning and the `Conflict #N not found` error so an agent that read part of a conflicted file learns which ids exist and how to get the rest, instead of guessing the next numbers.

| After `read six.ts:1-18` (3 of the file's 6 conflict blocks) | `main` | This PR |
|---|---|---|
| Warning header | ``⚠ 3 of 6 unresolved conflicts visible in this window (read `six.ts:conflicts` for the full list).`` | ``⚠ 3 of 6 unresolved conflicts visible in this window; this read registered only the blocks below, so don't infer ids for the others — read `six.ts:conflicts` to list and register every block.`` |
| `read conflict://4` | ``Conflict #4 not found. Conflict ids are registered when `read` surfaces a marker block; re-read the file to get a current id.`` | ``Conflict #4 not found: it was resolved, or no `read` has shown its block yet (a ranged read registers only the blocks it shows, so unseen blocks' ids can't be guessed). Read `<path>:conflicts` on the file to list and register every block. Registered: #1, #2, #3 in six.ts.`` |

## Why

A ranged read registers only the blocks it shows, numbered in the order they were first seen. Agents reading "3 of 6 visible" take the hidden blocks to be #4-#6, and `main`'s error sends them to re-read the same range. In local sessions since 2026-10-14, 15 of 23 `Conflict #N not found` errors came right after such a partial view, 11 of them with no git operation in between.

Decision: messages only. Registering the hidden blocks during a partial read would make `conflict://4` work at once, but a uniform `conflict://*` write resolves every registered conflict, so it would also resolve blocks the agent never saw. `<path>:conflicts` already registers every block on request, so the fix points there.

## Testing

- `bun test test/tools/conflict-integration.test.ts test/tools/conflict-detect.test.ts`: 95 pass. New cases: six blocks, `read six.ts:1-18` says 3 of 6 and not to infer the others' ids; `read conflict://4` fails naming `#1, #2, #3 in six.ts`; after `read six.ts:conflicts`, `conflict://4` renders the fourth block. And: `a.ts:1-5` registers #1, `b.ts` registers #2, #1 is resolved; writing or reading `conflict://1` again says it may have been resolved, points to `<path>:conflicts` for the intended file, and lists `#2 in b.ts` only as what is registered.
- Negative control: with the two source files reverted to `main`, both new tests and the updated window-warning test fail.
- `bun run check` in `packages/coding-agent` (oxlint, oxfmt, tsgo) passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
