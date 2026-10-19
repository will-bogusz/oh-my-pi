## What

I made a turn that omp stops for a thinking loop keep the usage, timing and response id the provider had already reported, because those turns were saved as free, instant requests stamped with the time they failed.

The loop guard replaces an aborted attempt with its own error message, and that message started from zeros. It now carries what the attempt that tripped had:

| Field on the saved error turn | `main` | This PR |
|---|---|---|
| `usage` (tokens, cost) | all 0 | what the provider had reported when the guard tripped |
| `responseId` | missing | the provider's id (OpenRouter's is the generation id) |
| `duration`, `ttft` | missing | from that attempt's start to the trip and to its first delta |
| `timestamp` | when it failed | when the attempt started, like every other turn |

## Why

Thinking-loop aborts are long turns: 5 aborted DeepSeek V4.1 Flash turns on OpenRouter in my sessions had each streamed 10–23 s against ~116k tokens of context, and all 7 saved loop aborts in my transcripts read $0 with no duration.

How much usage there is depends on the wire. Providers that report usage while streaming (Anthropic at `message_start`, Gemini on every chunk) hand it over; Responses and Chat Completions report it only at the end, so those turns still read 0 tokens but now keep the response id, which on OpenRouter is enough to look the generation's real cost up.

Decisions:
- Timing is tied to the provider snapshot the guard last saw: a provider retry starts a new snapshot, so its backoff and the earlier attempt never count. The guard does not wait for the aborted provider to finish, which would put its teardown on the retry path.
- A loop found at the end-of-stream flush takes the final message, timing included.
- Leaked-thinking healing (non-official endpoints) projected a copy of the provider's message made at stream start, so usage a provider replaces later (Gemini does per chunk) never reached the guard; the projection now follows the source's non-content fields.

Non-goals: estimating unreported tokens from the streamed text. Session totals (`getSessionStats`) count only messages still in context, and a retried error turn leaves context, so the recovered attempt's usage shows in the session journal but not there; that holds for every retried error kind and is separate.

## Testing

Through the real providers (`stream()` with a scripted SSE response that repeats one sentence until the guard trips):

| Wire | `main` | This PR |
|---|---|---|
| Anthropic, `claude-haiku-4-5` | 0 tokens, $0, no id, no timing | 116,000 input, $0.116, `msg_loop`, ttft and duration set |
| OpenRouter Responses, `deepseek-v4.1-flash` | 0 tokens, no id, no timing | 0 tokens (none reported yet), `gen-loop-1`, ttft and duration set |

Four new cases in `thinking-loop.test.ts` (usage, start, id and timing kept; a retried attempt reports only itself; the end-of-stream flush takes the final message; usage replaced mid-stream reaches the guard through leaked-thinking healing) fail with the source changes reverted; the last fails with only the healing change reverted. The ai suite passes (6,058).

```
bun test packages/ai/test/thinking-loop.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
