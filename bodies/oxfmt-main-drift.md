## What

I fixed the two things that keep main's "Lint, type check & web build" job red once `bun install` works again: six unformatted files and one metaharness test still calling the old `saveArtifact` signature.

- **oxfmt drift:** the repo's pinned `oxfmt` 0.65.0 (via `bun run check:tools`) rewraps lines in six files. This is formatter output only, with no hand edits and no token changes.
- **`saveArtifact` arity:** b2795320363 dropped `saveArtifact`'s second parameter and moved spills to `<session>/local/<id>.log`. `packages/metaharness/adapters/edit/runner.test.ts` still passed `"read"` (TS2554). It also expected the copied spill at the dump folder's top level, but `writeConversationDump` copies the session folder whole, so the copy is at `run-1/local/0.log`. The test now calls the one-argument form and expects the copy at the spill's path relative to the session folder.

| Cause | Files | From |
| --- | --- | --- |
| oxfmt | `packages/ai/test/claude-usage-{endpoint,headers,retry}.test.ts` | d5ea5dccf84 |
| oxfmt | `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/tui/src/prompt/custom-editor.ts` | c910e912584 |
| oxfmt | `packages/coding-agent/test/tools/fetch-kagi-toggle.test.ts` | b2795320363 |
| `saveArtifact` | `packages/metaharness/adapters/edit/runner.test.ts` | b2795320363 |

## Why

These commits landed this morning while CI failed at `bun install` (stale export viewer metadata), so the format and type-check steps never ran on them. With installs passing, `ci:check:full` fails in every run on `main` and on open PRs.

No CHANGELOG entry: formatting and a test fix, nothing a user sees.

## Testing

- On `main` (2cdc756f931), `bun run check` fails on the six files' formatting and on TS2554 in `runner.test.ts`. On this branch, `bun run check` and `bun run collab:web:build` (the job's other steps) exit 0.
- `bun test adapters/edit/runner.test.ts` in `packages/metaharness`: 10 pass. Before the path fix, the copy test failed with ENOENT on `run-1/0.log`.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
