## What

I removed the `jobs` op from `buildJobResult` because nothing has called it since `wait` and `proc://` replaced the `hub` tool, so it was dead code sitting in the wait and cancel path.

`wait`, `cancel` and `proc://` produce the same output and consume results the same way; the code diff is +14/−46 lines.

- `buildJobResult` loses its `"jobs"` branch (the `## Jobs` listing and its skip of result consumption) and its `op` type narrows to `"wait" | "cancel"`.
- `snapshotJobs` loses its `includeResults` option: only the `jobs` op passed `false`, and the two `proc://` callers passed `true`, the default.
- `CoordinationOp` in `@oh-my-pi/pi-tui` drops `"jobs"`.

## Why

`f89a6db15e9` (shipped in v18.10.0) replaced the `hub` tool with `wait` and the `proc://` protocol, and the `jobs` op lost its only caller. Every remaining `buildJobResult` call passes `"wait"` or `"cancel"`.

With `includeResults` always on, `snapshotJobs`'s `meta` condition, `(includeResults === false || !resultConsumed) && meta`, reduces to `!resultConsumed && meta`, the same as the other fields.

Old sessions that saved a `hub` result with `op: "jobs"` still load and render: the session loader does not check `details.op` against the union, and the TUI and web renderers pick a renderer by tool name, not by `op`.

Both packages export these symbols (`./async/*`, `tools/wait`), so each CHANGELOG gets a `Breaking Changes` line.

## Testing

- `bun run check` passes in `packages/coding-agent` and `packages/tui`.
- `bun test test/job-model-badge-renderer.test.ts test/tools/proc-service.test.ts test/tools/wait-structured.test.ts test/job-widgets/bash-widget.test.ts test/task/task-spawn.test.ts`: 60 pass.
- Equivalence against `origin/main`: `wait` and `cancel` results, `proc://` list and per-job reads, and result consumption compared over 240 combinations of job type, status, consumed state and payload; all matched.
- An old `hub` result with `op: "jobs"` replayed through session parsing, the `wait` renderer and the anonymizer: no error.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
