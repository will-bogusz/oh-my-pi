## What

I made the compaction cut point count the newest Claude turn's signed thinking when that turn stopped with its tool calls unrun, since the next request still sends that thinking and compaction was keeping far more recent history than `keepRecentTokens`.

A Claude turn that emits tool calls but ends on `stop` or `length` is "abandoned". `transformMessages` strips the thinking signatures of older abandoned turns, but on the Anthropic Messages API keeps the latest one byte-for-byte, as Anthropic requires. The tokenizer applied the older-turn rule everywhere, since one message's count cannot see its position.

| Case | Before | Now |
|---|---|---|
| Latest turn: 30,000 output tokens, tool call, `length` stop; 20,000 `keepRecentTokens` | counted at its visible blocks; the cut kept the whole history, a 40,000-character prompt included | counted at 30,000; only that turn is kept |
| Same turn on Bedrock (Converse replay strips its signatures), older abandoned turns, other callers | visible blocks only | unchanged |

## Why

This is the Codex finding left open on #15446 (`Preserve the latest abandoned turn's replay charge`). The latest turn's own usage anchors `estimateTranscriptTokens`, but `findCutPoint` sums `countMessage` with no anchor.

Decisions:
- A separate `Tokenizer.countLatestTurn`, not a count option: an option would reach every message through `countMessages`, and a message slice cannot know whether it ends the transcript.
- `findCutPoint` picks the latest turn through `isSurvivingAssistant`, which `transformMessages` now uses too (malformed tool calls dropped first, then truncated thinking-only turns), so the two cannot disagree.
- Only `anthropic-messages` turns are exempt, as in `transformMessages`: Bedrock's replay strips the signatures.
- `countLatestTurn` is not memoized: one message per call.

Non-goals: other positional callers of `countMessage` (pruning, the dead-end snapcompact rescue's kept tail) keep `main`'s count.

## Testing

- `countMessage replayed thinking > charges the reasoning of the latest turn that abandoned its tool calls on the Claude API only`: `countLatestTurn` charges a signed Opus 5.5 turn with a tool call and a `stop` or `length` stop its 3,000 output tokens; on Bedrock it keeps the visible count.
- `findCutPoint ... > counts the reasoning the latest turn replays when its tool calls were abandoned`: the cut lands on that turn as the newest entry (index 3), and still counts it behind a newer turn holding only a malformed tool call (index 4).
- Negative controls: with both packages' `src` reverted to `main`, all three fail (`Expected: 3, Received: 0`; `Expected: 4, Received: 0`). Without the API gate, Bedrock fails (`Expected: 14, Received: 3000`); selecting through `shouldDropTruncatedThinkingOnlyAssistant` as before fails the malformed case.
- `bun test test/compaction*.test.ts test/tokenizer.test.ts` (`packages/agent`): 98 pass; 17 replay and `transform-messages*` suites (`packages/ai`): 87 pass. `bun run check` in both: clean.

Not run: a live Claude session that hits `max_tokens` mid tool call; the replay rule itself is pinned by `transformMessages`' own tests.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
