## What

I kept seeing agents get `lsp` references that pointed at blank lines or unrelated code in test files they had just changed with bash, so I made the tool sync every open file from disk before those queries, the way rename already does.

An open file edited outside OMP (bash, a formatter, `git checkout`) now has its current text sent to the language server before `references`, `definition`, `type_definition`, `implementation`, `hover`, `code_actions` and workspace `symbols`, so the locations they return match the file on disk.

| Live, `typescript-language-server` 6.0.3; `b.ts` open, 5 lines prepended to it with bash | `main` | this PR |
|---|---|---|
| `references foo` | `b.ts:1:10`, `b.ts:2:22` (context lines are `// one`, `// two`) | `b.ts:6:10`, `b.ts:7:22` |
| workspace `symbols value`, after one more line | `b.ts:2:14` | `b.ts:8:14` |

**Beyond the fix:** the shared sweep no longer marks each file as used. On `main` every diagnostics call and rename ran it, so while they kept running no open file reached the 5-minute idle close. With the sweep now on most queries that would keep every file loaded for good, so the split (`syncOpenFileFromDisk`) stays with this PR.

## Why

A language server trusts a document OMP opened over the disk until OMP sends a `didChange`. The tool synced only the queried file, so a consumer opened earlier and then edited outside OMP kept its old text, and cross-file answers came back on its old line numbers. A code action that edits another open file can write onto those old lines, the failure rename had before it got this sweep (#15772).

Decisions:
- One sweep right before the request, after the project-load wait, for every action whose answer can draw on other open files (`CROSS_FILE_ACTIONS`). It replaces rename's own call at the same point; an edit that lands during the wait is still picked up. Document `symbols` and `reload` read only the target, which is already synced.
- Each sweep reads and hashes every open file and sends nothing for those that match. Idle close bounds how many are open, and diagnostics already paid this on every call.

Non-goals: the raw `request` action still syncs only its target; files OMP never opened are the server's file watchers' job. Related: #16880.

Reading order: `reconcileOpenFilesFromDisk` and `syncOpenFileFromDisk` in `lsp/client.ts`, then `CROSS_FILE_ACTIONS` and the workspace-symbol loop in `lsp/tool.ts`.

## Testing

- `syncs open consumers edited outside OMP before references and workspace symbols` (`test/tools/lsp-regressions.test.ts`): a fake server answers from the text it holds per document, and the second edit lands inside the project-load wait. With the `src/` changes reverted it fails (`consumer.py:2` instead of `:4`); with the sweep placed before the wait it fails on references. The `reconcileOpenFilesFromDisk` test now asserts the sweep leaves `lastUsedAt` alone; reverted, it is bumped to now.
- `bun test test/lsp/ test/tools/lsp*.test.ts` in `packages/coding-agent`: 222 pass.
- The table: a script driving `LspTool` against a real `typescript-language-server`, on `main` and on this branch.
