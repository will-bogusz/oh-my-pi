## What

I fixed a late tool error wiping the JavaScript eval kernel so an unawaited call no longer loses the session's variables.

A rejected bridge call retains its originating cell and tool or prelude method name. Finished-cell errors appear once in the next cell's output, capped at ten notices plus a count, while the kernel keeps its state.

## Why

A floating `waitForDownload()` can reject after another call has already failed the cell. The error is created outside the cell, so the existing rejection guard cannot identify its owner and takes the fatal-worker path.

This keeps the existing attribution guard rather than swallowing unrelated worker failures. The host still drains outstanding bridge calls before returning a cell result, preserving cancellation of delegated work; changing that wait is outside this fix.

## Testing

- `bun test packages/coding-agent/test/eval/worker-core.test.ts`: 12 passed. The subprocess regression uses the shipped browser prelude, rejects floated download waits after their cell fails, exceeds the notice cap, and verifies preserved state and one-time reporting. It also covers cell-file eviction and a late rejection while another cell is running.
- Negative control: the same regression against the original worker source fails when the fatal exception exits the subprocess instead of preserving state.
- `bun run check:ts` passed, with existing lint warnings outside this diff. Focused `oxlint` and `oxfmt` checks passed.
- No model sampling: attribution, state survival and delivery counts are deterministic worker behavior, verified at the transport boundary.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (PR link added by the queue opener)
