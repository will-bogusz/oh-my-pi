## What

I made a `conflict://*` write whose lines are all `<id>: <literal text>` fail like the other malformed per-id blocks, because today it quietly writes every line into every conflict block and says it resolved them.

| `write conflict://*` content, 2 blocks registered | `main` | This PR |
|---|---|---|
| `1: @ours`<br>`2: @theirs` | each block gets its side | same |
| `1: @ours`<br>`2: some text` | `Malformed conflict://* per-id block` | same |
| `1: foo`<br>`2: bar` | **both blocks become `foo` + `bar`**, result `Resolved 2 conflicts` | `Malformed conflict://* per-id block`, file untouched, ids stay registered |
| `42:cleanline` (a copied line number, no conflict #42) | every block becomes `cleanline` | same |

## Why

Per-id bulk only takes `@ours`/`@theirs`/`@base`/`@both` values. A block that mixes valid directives with literal lines already fails (`parseBulkDirectives`), but one with no valid directive at all returns `null`, so the write falls into uniform mode: the same content goes into every block. In hashline mode the `1:`/`2:` heads are then stripped as echoed line numbers, so nothing in the written file shows the ids were ever there. Agents write this shape when they mean "block 1 gets this line, block 2 gets that one". In local sessions it happened 6 times between 2026-09-28 and 10-15, each reported as a success.

Decision: the new check fires only when every non-empty line has a per-id head naming a registered conflict. Matching any `N:` head would also reject uniform content pasted with its read line numbers, which stripping handles today; file line numbers that all happen to equal registered conflict ids are the only content this PR newly refuses, and the error says to use one `conflict://<N>` write per block.

## Testing

- `bun test test/tools/conflict-integration.test.ts`: 39 pass. New cases: `1: foo\n2: bar` on two blocks fails with the token error in hashline mode, and in plain mode (`hasEditTool: false`) with the malformed-block error; the file is unchanged and #1/#2 stay registered. A uniform `42:cleanline` still strips and resolves.
- Negative control: with `conflict-uri.ts` reverted to `main`, both rejection tests fail (the write resolves).
- `bun run check` in `packages/coding-agent` (oxlint, oxfmt, tsgo) passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
