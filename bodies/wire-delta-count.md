## What

I dont want to necessarily accept this solution we have right now as the best approach, though its a decent start

After a model switch, a Claude session read by Gemini 3.8 Flash through Factory was estimated 10% above the request omp sends; now 1.5%. The estimate counted earlier turns' thinking through a copy of the adapters' replay rules, which had drifted; it now counts each turn as the reader's own replay passes produce it.

> **Context.** The status line and compaction checks add a local count of turns since the last reported usage, or of the whole history after a switch. Adapters replay another model's thinking demoted, dropped or signed.

Median estimate against the request body omp builds, in o200k (these readers' tokenizer):

| Requests rebuilt at a model switch | `main` | this PR |
|---|---|---|
| Gemini 3.8 Flash via Factory, Claude sessions (10) | +10.1% | +1.5% |
| Gemini 3.8 Flash via Factory, Codex sessions (10) | −0.2% | −0.2% |
| GPT-6.1 Sol, Claude sessions (20) | −3.1% | −2.9% |
| Grok 4.7, Claude sessions (14) | −5.0% | −4.6% |

Against billed tokens the Factory Gemini Claude rows go from −3.6% to −13.0%: the old surplus offset Gemini's tokenizer, which reads about 18% above o200k here.

## Why

- **Decision:** count the real per-turn replay. `transformAssistantTurn` is `transformMessages`' per-turn body, extracted unchanged; `replayView(model)` pairs it with the model the request encodes for (Factory's inner wire) and each adapter's own pass (Factory Gemini, completions, Ollama, Devin, Cursor, GitLab Duo). The memo stays per message and reader. `dropsForeignReasoningPayload`, `DIRECT_REPLAY_APIS`, the Factory Gemini helpers and the Tokenizer's own replay rules go.
- **Rejected:** all of `transformMessages` per count (a full-history walk on every streaming update), and encoding provider payloads (async, credentialed).
- **Kept:** billing rules that are not wire rules (`thinking-replay-tokens`, Responses reasoning at reported tokens).
- **Send path:** images to a reader without image input count as the omission note sent instead. No send step truncates tool results: tools truncate output when they run, so the stored result is the one sent. Not covered: results snapcompact images at send time, async and decided per request. The largest overcount, a 40.7k-token tail billed about 20k, is five such results (15.8k tokens journaled as saved).
- #17422 is unchanged: that gateway receives the thinking and does not bill it.

## Testing

- `tokenizer.test.ts` compares each case with the payload the real encoder builds: a Claude-signed turn read by `factory-droid` `gemini-3.8-flash`, a reader without image input, cold and warm Factory Responses, a partial Factory row. They fail with the source reverted.
- 4,808 anchored tool-loop pairs from real sessions count identically on both (a same-model tail crosses no replay rule). The 126 switch requests were rebuilt and captured, never sent.
- Cost on a 5,755-message session: cold 84-308 ms per reader (`main` 102-405), warm 0.11-0.16 ms.
- `bun check`: types and lint pass; oxfmt flags two files unformatted on `main`.

<details><summary>Cost per reader (5,755-message Claude session)</summary>

| Reader | cold ms `main` → PR | warm ms | latest turn µs |
|---|---|---|---|
| anthropic/opus-5.5 | 308.5 → 307.7 | 0.138 → 0.137 | 0.58 → 0.61 |
| openai-codex/gpt-6.1-sol | 220.2 → 124.5 | 0.163 → 0.161 | 0.37 → 0.70 |
| google/gemini-3-pro | 102.2 → 105.8 | 0.111 → 0.125 | 0.33 → 0.65 |
| factory-droid/gemini-3.8-flash | 102.3 → 83.7 | 0.105 → 0.113 | 0.27 → 0.44 |
| zai/glm-5.3 | 405.1 → 104.1 | 0.171 → 0.116 | 0.36 → 0.65 |

</details>

```sh
cd packages/agent && bun test test/tokenizer.test.ts test/branch-summarization.test.ts
cd packages/ai && bun test test/transform-messages-*.test.ts test/factory-droid-*.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
