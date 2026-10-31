## What

I'd like to explore the idea of snapcompact fallback when switching models, and generally exploring more cross model/provider switching behaviors. I have a feeling this is underexplored right now, and probably not optimized.

One case: after switching to Claude from Gemini, Kimi or Codex, Claude sometimes refused the whole turn over the other model's reasoning we carry along, and for some switches that reasoning no longer reached it, so this fixes the carry and retries a refused turn once without it.

On real model-switch points from the author's sessions, turns refused over carried reasoning go from 3 of 21 to 0 of 21 (paired runs, below), and Codex, Kimi and Grok turns that `main` stripped reach Claude again.

| After a switch to Claude | main | this PR |
|---|---|---|
| Claude refuses the turn (`Refusal (reasoning_extraction)`) because it carried another model's reasoning | the turn ends with the refusal, or the fallback chain takes it | retried once on Claude without that reasoning; the session's later Claude requests leave it out |
| Earlier Codex, Kimi or Grok turns recorded under their own credential, or kept through a compaction | their reasoning is dropped | sent as text, like on every other switch |

> **Context.** Claude replays only its own signed thinking natively, so omp sends another model's reasoning to Claude as plain assistant text ("demoted"). Claude's input classifier sometimes refuses a request that quotes reasoning back, mid-stream, with `stop_details.category: reasoning_extraction`.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/7e73d99c-113b-44bc-bc98-13d3e6e73aaa">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/112dfe27-1b84-49d2-8b98-d13ea1a3f1a5">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/5d31f557-bd14-487a-b323-a1af501133ff">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/9dc7cad2-e64e-4b82-b477-818c0dc5cef6">
  <img width="780" alt="Decision flow. Is the refusal category reasoning_extraction? No: fallback chain or the refusal ends the turn, as on main. Did the refused request carry another model's reasoning as text? No: same as main. Has this session already left that reasoning out? Yes: same as main. Otherwise main walks the fallback chain or ends the turn, while this PR retries once on Claude without that reasoning and leaves it out of the session's later Claude requests. Like any automatic retry, it also needs retries enabled, one left under retry.maxRetries and a replay-safe turn, on a Claude model." src="https://github.com/user-attachments/assets/112dfe27-1b84-49d2-8b98-d13ea1a3f1a5" />
</picture>

## Why

Carried reasoning is worth keeping: on questions only the earlier model's reasoning answers, dropping it scored 0.773 against 0.948 in paired runs; carrying and stripping only on a refusal scored 0.935, with no turn left refused.

Since credential-aware replay (7106a00f612), every Codex, Kimi or Grok turn carries its own provider's credential id, so `transformMessages` dropped its thinking on a signing Anthropic target before demotion ran; the compaction prefix-binding drop did the same to the kept tail. Both rules protect signed replay, which plain non-Claude reasoning never uses.

The refusal arrives mid-stream, after seconds of thinking, so the transport's pre-first-token retry can't take it: turn recovery re-sends the turn, as the advisor does (#17475). It retries only when the refused request carried that reasoning; a request that carried none was refused again in every run.

**Decision for the maintainer:** keep demotion as the default and recover from the refusal (roboomp's option 2 on #7241), rather than drop the reasoning on every switch.

**Cost:** +6% billed input per turn where `main` already carried the reasoning (199K → 211K), both attempts counted.

<details><summary>Decisions, maintenance and reading order</summary>

- **Gating:** once per session, and like every automatic retry it needs retries on, one left under `retry.maxRetries` and a replay-safe turn; only models whose catalog marks `classifier-cot-extraction` (Claude). A refusal that outlives the strip takes `main`'s path (fallback chain or the error).
- **Scope of "session":** main requests and side requests over the same history (native compaction, handoff) leave the reasoning out together, so a compaction request still matches the live prefix. The decision is not saved: a reloaded session relearns it from its next such refusal, one extra refused request, rather than adding a session entry that has to follow rewinds and branches.
- **History change:** the strip edits the history once, so that request writes the prompt cache again, and on prefix-bound models Anthropic drops Claude's thinking signed against the old prefix (its default `drop_block`).
- **Kept out of the restored carry, as on `main`:** redacted thinking, and reasoning from any model the catalog classes as Claude for its provider, from another host or account.
- **Not changed:** unsigned blocks beside signed thinking in Claude's own turn keep their text replay and are not counted.
- **Rejected:** dropping carried reasoning by default (#7241's proposal) lowered reasoning-only recall by 0.175 in the paired cases, while stripping only on a refusal cleared all three refused turns.
- **Maintenance:** the trigger is Anthropic's category string `reasoning_extraction`. If it changes, the retry stops firing and refusals take today's path.
- Related: #17304 and #17413 also change classifier-refusal handling in `#applyRetryPolicy`.

Reading order:

- `transformMessages` (`ai/src/providers/transform-messages.ts`): `keepsBoundThinking` exempts another provider's non-Claude thinking from the credential and prefix-binding drops.
- `encodeAnthropicMessages` (`ai/src/providers/anthropic.ts`): `omitDemotedReasoning` skips demoted blocks, else counts them; a refusal reports the count as `demotedReasoningBlocks`.
- `TurnRecovery.#applyRetryPolicy` (`coding-agent/src/session/turn-recovery.ts`): `stripDemotedReasoning`, then the same-model retry; `omitsDemotedReasoning` gates on the catalog's `classifier-cot-extraction`. `sdk.ts` sets the option on primary requests, `AgentSession` on side requests.

</details>

## Testing

Live on this branch (910cd553c32; the later commit changes only side requests and the Claude-source check) with Claude Opus 5.5, whose classifier refuses, on real switch sessions:

- From Gemini: refused after ~12 s, retried with no delay, answered (80,761 input tokens against 87,465 refused).
- Kimi under a foreign credential: carried now (96,978 tokens against 84,432 on `main`), no refusal.
- Codex under a foreign credential: the restored carry was refused; the retry answered.

<details><summary>Measurements</summary>

Real foreign → Claude switch points, uncompacted prefix resumed on Claude Opus 5.5 (thinking medium), 2 runs each, one quiz per run: questions on the visible history, and questions whose answers exist only in the earlier model's reasoning, graded by a model of another family. Changes are paired over cases, with 95% intervals. The runs used an experiment build of `main` with the same carry and strip switched by flags, not this branch; its live checks are above.

Switch points where `main` carries the reasoning (11 cases). The strip-on-refusal row is derived: each refused run is paired with the same run's request without the reasoning, which is the request this PR re-sends, billed for both attempts (24 requests over 21 turns):

| request | turns refused | billed input per turn |
|---|---|---|
| carried (`main`) | 3/21 | 199K |
| reasoning dropped | 1/22 | 178K |
| carried, stripped on a refusal (derived) | 0/21 | 211K |

| reasoning-only questions | n | before | after | change [95% CI] |
|---|---|---|---|---|
| carried → dropped | 10 | 0.948 | 0.773 | −0.175 [−0.275, −0.080] |
| carried → stripped on a refusal | 10 | 0.948 | 0.935 | −0.013 [−0.037, +0.000] |

Switch points where `main` drops it (5 cases: Kimi, Grok and Codex under their own credential, Kimi after compaction): restored carry 0.912 against 0.762 on `main` (+0.150 [+0.037, +0.287]), 0/10 refusals either way, 137K against 129K billed input. Visible-history questions differ by at most 0.008 in every comparison.

</details>

<details><summary>Tests</summary>

The Codex, Kimi and post-compaction carry tests, the catalog-class test, the retry and second-refusal tests and the compaction test fail with their change reverted; the others guard what must not change.

- `ai/test/anthropic-stream-envelope.test.ts`: a refused request reports 2 demoted blocks; with `omitDemotedReasoning`, both are left out and Claude's own unsigned block stays.
- `ai/test/anthropic-prior-turn-thinking.test.ts`: Codex and Kimi under another credential, and Kimi before a compaction, arrive as demoted text; a Claude turn, and a distill the catalog classes as Claude on its provider, under another credential are still dropped; the option removes the restored blocks.
- `coding-agent/test/agent-session-retry-fallback.test.ts`: one same-model retry before the fallback chain, kept on the next prompt; no retry when nothing was carried; a second refusal walks the chain.
- `coding-agent/test/agent-session-anthropic-native-compaction.test.ts`: after a stripped retry, a native compaction request leaves the reasoning out and matches the live prefix.

```
cd packages/ai && bun test test/anthropic-stream-envelope.test.ts test/anthropic-prior-turn-thinking.test.ts
cd packages/coding-agent && bun test test/agent-session-retry-fallback.test.ts test/agent-session-anthropic-native-compaction.test.ts
```

</details>

Closes #10407
Closes #7241

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
