## What

I'd like to explore the idea of snapcompact fallback when switching models, and generally exploring more cross model/provider switching behaviors. I have a feeling this is underexplored right now, and probably not optimized.

The context estimate after a switch to Grok or Gemini is one place it shows: omp guessed their tokens at 4 bytes each, so compaction fired late.

After a switch to Grok 4.7, a request Grok billed at 358,493 input tokens was estimated at 221,840 (−38%); it is now 351,057 (−2%). The same request under Factory's Gemini 3.8 Flash goes from 209,071 to 338,287 against 402,518 billed (−48% → −16%).

> **Context.** Every compaction trigger, fit check and the status line count context with the active model's tokenizer. The catalog names one for Claude, GPT, Qwen, DeepSeek, Kimi and GLM; for any other model `Tokenizer.countTokens` fell back to bytes/4. On code, paths, hex addresses and ids that is 2–2.5 bytes per token, so those models were undercounted by up to half.

Median estimate error against the provider's billed input, 21 requests replayed from a compaction eval (the session text at the moment of a model switch):

| Requests | `main` | this PR |
|---|---|---|
| Grok 4.7, Codex sessions (8) | −22% | −9% |
| Grok 4.7, Claude sessions (9) | −5% | −10% |
| Gemini 3.8 Flash via Factory (4) | −22% | −16% |

**Beyond the fallback:** the Claude rows were close on `main` only because two errors cancelled. Every turn's thinking signature was charged to every reader, also where `transformMessages` strips it: another model's turn on a wire that encodes against the reader itself (Claude → Grok, Gemini → another Gemini). With o200k alone those rows land at +38% (up to +92%); with both changes, −11% to −8%.

## Why

- Unknown families count in o200k_base: the natives default, and what `PI_TOKENIZER_ACCURATE=1` opted into. That flag is removed. Tests keep the byte estimate outside `strict`.
- Signatures: `dropsForeignReasoningPayload` sits in `transform-messages.ts` beside the rules it mirrors. It answers "certainly stripped" only for directly encoded APIs and a turn that is not the reader's own. Anthropic → Anthropic replays (deployment and signing rules can keep foreign signatures) and agent proxies (Factory, Cursor, Devin, GitLab Duo, whose inner wire the tokenizer can't see) stay charged, as on `main`.
- Rejected: mapping Gemini or Grok to the nearest embedded vocabulary. Some fit closer on this data (Gemini's billed count is within 2–6% of the Claude 3 and Jev counts), but they are other vendors' tokenizers, and that choice belongs in catalog policy with its own measurements.
- Cost: native counting where bytes/4 was arithmetic. GPT and Claude sessions already pay it on every count, behind the same per-message memo and fragment cache.

Non-goal: Gemini still reads about 15% under; its tokenizer is denser than o200k on this text.

## Testing

- Replay: 21 eval requests that were billed on 2026-10-30. Each was rebuilt by omp from the same session and captured locally (never sent), and the estimate read from `getState().contextUsage`, on `main` and this branch. The two headline requests (eval case `codex-03`) read a re-expanded OpenAI remote compaction, so they were rebuilt on the queued re-expansion branch with and without this change.
- `tokenizer.test.ts`: o200k outside the test env (a `NODE_ENV=production` subprocess) fails on `main`. Six signature cases compare the charge with what `transformMessages` keeps (after Factory's Gemini adoption pass): Claude → Gemini and Gemini → Gemini are stripped and fail on `main`; Factory's own and Gemini CLI turns, and GLM and MiniMax turns to a compatible Anthropic endpoint, are kept and charged. The test that priced a signature for a re-encoding Codex reader now asserts it is not charged.

```sh
cd packages/agent && bun test test/tokenizer.test.ts
```

<details><summary>Per-request numbers</summary>

| Request (eval case, compacted by, target) | Billed | `main` | this PR |
|---|---|---|---|
| claude-02, soft, gemini-3.8-flash | 20,499 | 16,958 (-17%) | 17,646 (-14%) |
| codex-01, soft, gemini-3.8-flash | 26,393 | 19,952 (-24%) | 22,977 (-13%) |
| codex-02, soft, gemini-3.8-flash | 22,900 | 18,475 (-19%) | 18,653 (-19%) |
| codex-05, soft, gemini-3.8-flash | 31,968 | 20,819 (-35%) | 24,708 (-23%) |
| claude-01, remote, grok-4.7 | 20,496 | 24,009 (17%) | 18,436 (-10%) |
| claude-04, soft, grok-4.7 | 22,879 | 19,211 (-16%) | 21,135 (-8%) |
| claude-04, remote, grok-4.7 | 20,020 | 16,553 (-17%) | 18,316 (-9%) |
| claude-07, soft, grok-4.7 | 22,209 | 21,148 (-5%) | 19,730 (-11%) |
| claude-07, remote, grok-4.7 | 22,552 | 21,418 (-5%) | 20,063 (-11%) |
| claude-08, soft, grok-4.7 | 20,512 | 20,209 (-2%) | 18,362 (-11%) |
| claude-10, soft, grok-4.7 | 20,642 | 21,726 (5%) | 19,038 (-8%) |
| claude-12, soft, grok-4.7 | 21,542 | 19,713 (-9%) | 19,485 (-10%) |
| claude-12, remote, grok-4.7 | 21,921 | 20,010 (-9%) | 19,877 (-9%) |
| codex-02, soft, grok-4.7 | 20,766 | 18,472 (-11%) | 18,651 (-10%) |
| codex-01, soft, grok-4.7 | 24,961 | 19,929 (-20%) | 22,947 (-8%) |
| codex-07, soft, grok-4.7 | 26,001 | 20,377 (-22%) | 23,393 (-10%) |
| codex-09, soft, grok-4.7 | 23,494 | 18,959 (-19%) | 21,068 (-10%) |
| codex-05, soft, grok-4.7 | 27,180 | 20,816 (-23%) | 24,706 (-9%) |
| codex-11, soft, grok-4.7 | 29,538 | 19,787 (-33%) | 26,703 (-10%) |
| codex-12, soft, grok-4.7 | 27,723 | 19,651 (-29%) | 25,209 (-9%) |
| codex-04, soft, grok-4.7 | 27,317 | 18,768 (-31%) | 24,882 (-9%) |

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
