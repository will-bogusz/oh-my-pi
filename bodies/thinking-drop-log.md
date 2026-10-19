## What

After a long idle my omp log would fill with hundreds of identical "dropped thinking block" warnings from a single request, so now it says it once with a count.

When the API drops replayed thinking blocks from a request, omp wrote one warning per dropped block (147 lines in 3 ms after one 62-minute idle, 327 for one request at most); it now writes **one warning for the request** with the count and the first path, on both the Anthropic and Bedrock providers.

| Blocks dropped in one request | Warnings on `main` | Warnings with this PR |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 1 (`count: 2`) |
| 10 | 10 | 1 |
| 147 | 147 | 1 |
| 327 | 327 | 1 |

> **Context.** Under `drop_block`, the API drops signed thinking it can no longer bind to a changed conversation prefix and lists each drop on the response (`input_transformations`). Since #14748 the Anthropic provider keeps replaying those blocks so the prompt cache holds, and remembers which drops it already warned about, so later requests that re-report them log at debug.

## Why

A wake after an idle or a compaction drops one block per earlier assistant turn, all from the same prefix change, so one line per block buries the rest of the log.

Decisions:
- One helper, `logDroppedThinking`, serves both providers: one warning with `count` and the first `path`, plus one debug line with every path when more than one dropped. The message text is unchanged, so existing log searches still match.
- Anthropic's cross-request dedupe is unchanged: already-warned blocks still log one debug line with a count, and only new drops count toward the warning. The summary is per response report, so only a block first reported on `message_delta` after others on `message_start` adds a second line.

Non-goal: Bedrock has no cross-request dedupe (it does not keep provider session state), so it still warns once on every request that reports drops; that needs its own state and is a separate change.

## Testing

- `anthropic-prefix-drop-replay.test.ts`: the two-block fixture now asserts one warning with `{ count: 2, path: "messages.1.content.0" }`, the debug line with both paths, and no new warning on the replayed second request, for drops reported on `message_start` and on `message_delta`.
- `bedrock-prefix-binding-retry.test.ts`: a new case streams a `messageStop` reporting two drops and asserts one warning with `count: 2`.
- Negative control: with the `src/` changes reverted, all three cases fail (`Expected length: 1, Received length: 2`).
- The table: a mock Anthropic stream with K signed thinking turns and K reported drops, counting `logger.warn` calls per request on `main` and on this branch. Each run's second request warns 0 times on both.
- Projected on my own omp logs (47 files with the warning): 11,052 warning lines came from 176 back-to-back bursts, which would log 176 warnings and 173 debug lines with this change; excluding the one long research session that wrote half of them, 5,175 lines from 116 bursts.
- `bun test packages/ai/test/anthropic*.test.ts packages/ai/test/bedrock*.test.ts`: 679 pass; `bun run check` in `packages/ai` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)