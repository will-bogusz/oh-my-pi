## What

I made the compaction cut point count the newest Claude turn's signed thinking when that turn stopped with its tool calls unrun, since the next request still sends that thinking and compaction was keeping far more recent history than `keepRecentTokens`.

A Claude turn that emits tool calls but ends on `stop` or `length` (max tokens) is "abandoned". `transformMessages` strips every thinking signature from older abandoned turns, but on the Anthropic Messages API it keeps the latest one byte-for-byte, as Anthropic requires for its own most recent response. The tokenizer applied the older-turn rule to every message, because a per-message count cannot see position.

| Case | Before | Now |
|---|---|---|
| Latest turn: 30,000 output tokens, tool call, `length` stop; 20,000 `keepRecentTokens` | counted at its visible blocks; the cut kept the whole history, a 40,000-character prompt included | counted at 30,000; only that turn is kept |
| Same turn on Bedrock (Converse replay strips its signatures), older abandoned turns, other callers | visible blocks only | unchanged |

## Why

This is the Codex finding left open on #15446 (`Preserve the latest abandoned turn's replay charge`). That PR's comment at the rule said the latest turn's own usage anchors transcript counts, which holds for `estimateTranscriptTokens`, but `findCutPoint` sums `countMessage` with no anchor.

Decisions:
- An explicit `latestTurn` option rather than a position-aware `countMessages`: the cut point walks entries, not a message list, and a slice of messages cannot know whether it ends the transcript.
- `findCutPoint` picks the latest turn the way `transformMessages` does (newest assistant not dropped as a truncated thinking-only turn), so the two cannot disagree on which turn keeps its signatures.
- The exemption follows `transformMessages`' gate (`anthropic-messages` turns only), so a Bedrock turn whose signatures the replay strips keeps its visible-only count.
- The latest-turn count is not memoized; it is one message per call, and the memo keeps the older-turn count other callers read.

Non-goals: other positional callers of `countMessage` (pruning, the dead-end snapcompact rescue's kept tail) keep `main`'s count.

## Testing

- `countMessage replayed thinking > charges the reasoning of the latest turn that abandoned its tool calls on the Claude API only`: with `latestTurn`, a signed Opus 5.5 turn with a tool call and a `stop` or `length` stop counts its 3,000 output tokens; without it, the visible count; the same turn on Bedrock Opus 5.5 keeps the visible count either way.
- `findCutPoint backward scan boundaries > counts the reasoning the latest turn replays when its tool calls were abandoned`: the cut lands on the latest turn (index 3).
- Negative control: with `packages/agent/src` reverted to `main`, both fail (`Expected: 3000, Received: 14`; `Expected: 3, Received: 0`). With the API gate removed, the Bedrock assertion fails (`Expected: 14, Received: 3000`).
- `bun test test/compaction*.test.ts test/tokenizer.test.ts` in `packages/agent`: 97 pass. `bun run check:ts`: clean (no Rust changed).

Not run: a live Claude session that hits `max_tokens` mid tool call; the replay rule itself is pinned by `transformMessages`' own tests.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
