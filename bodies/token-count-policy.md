## What

id like to do some deeper research online on github and the web generally to learn more about sota tokenizers, and whether there are more appropriate native solutions we can find at the source of various providers/services

After a model switch, omp's context estimate for Grok 4.7 goes from 11.3% under the billed prompt to 0.8% under (median of 21 rebuilt requests), Kimi K3 from 6.5% to 4.0% under, and Claude Opus 5.5's worst case from 8.3% to 4.9% under.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/94547148-38d0-43ad-825e-1dad5f2c658b">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/cdb066bf-8a87-4f4d-8428-539564671ea2">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/344e156a-e986-46a9-8694-3c467919f4a0">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/d723642d-698e-44a7-899d-4775661eafa6">
  <img width="780" alt="Every request as a dot. After a model switch, omp's context estimate against the billed prompt, main → this PR: Grok 4.7 11.3% → 0.8% under (median of 21; worst 33.1% → 3.8% under); Kimi K3 6.5% → 4.0% under (median of 5; worst 6.7% → 4.7% under); Claude Opus 5.5 2.9% → 2.8% under (median of 15; worst 8.3% → 4.9% under)." src="https://github.com/user-attachments/assets/cdb066bf-8a87-4f4d-8428-539564671ea2" />
</picture>

<details><summary>Exact numbers (88 requests)</summary>

| Model after the switch | Requests | main: estimate vs billed, median [p10, p90], worst | this PR | Moved |
|---|---|---|---|---|
| Grok 4.7 | 21 | −11.3% [−30.8, −9.1], worst −33.1 | −0.8% [−3.0, −0.0], worst −3.8 | 21/21 |
| Kimi K3 | 5 | −6.5% [−6.6, −6.3], worst −6.7 | −4.0% [−4.4, −3.9], worst −4.7 | 5/5 |
| Claude Opus 5.5 | 15 | −2.9% [−8.2, −2.3], worst −8.3 | −2.8% [−3.5, −1.8], worst −4.9 | 15/15 |
| GPT-6.1 Sol | 15 | −2.9% [−3.6, −1.2], worst −4.7 | same | 0/15 |
| GLM-5.3 | 12 | −3.3% [−8.2, −3.1], worst −8.2 | same | 0/12 |
| Gemini 3.8 Flash | 20 | −11.0% [−19.0, −1.2], worst −22.8 | same | 0/20 |

</details>

**Unchanged:** GPT-6.1 Sol, GLM-5.3 and Gemini 3.8 Flash have no framing (0 of 47 estimates moved); anchored estimates are byte-identical.

Each model line's tokenizer and endpoint framing now live in one KDL block, `token-count`.

> **Context-estimate context.** omp sizes the context from the last turn's billed prompt plus a local count of what followed (*anchored*). With no usable last turn (fresh session, model switch, after compaction) it counts the whole request locally (*unanchored*) and misses what the endpoint adds around the text (a per-request base, Claude's tool prompt).

<details><summary>KDL shape and reading order</summary>

```kdl
family "grok" {
	revision ">=4.7 <4.20" {
		token-count {
			tokenizer "o200k"
			verified #true
			scale 1.053
			base 1065
		}
	}
}
```

Fields: `tokenizer`, `scale`, `base`, `per-message`, `tool-preamble`, `per-tool`, `verified`. Framed estimate = `round(scale × local) + base + per-message × messages`, plus `tool-preamble + per-tool × tools` when tool schemas ship.

1. `catalog/src/compat/token-count.ts`: payload, compile-time check, `frameTokenEstimate`.
2. `catalog/src/model-tokenizer.ts`: `resolveModelTokenCount`; `resolveModelTokenizer` returns its `tokenizer`.
3. `rules/classes/*.kdl`: the moved tokenizer mapping and the seeds with sources.
4. `coding-agent/src/session/token-framing.ts` and its call sites in `session-stats.ts`, `session-maintenance.ts`, `session-advisors.ts`.

</details>

## Why

Tokenizer choice and endpoint framing are per-model policy, which AGENTS.md puts in KDL. The mapping is unchanged for every bundled row (tested against each row's baked `tokenizer`); Grok 4.7 now names `o200k`, already its fallback.

Seeds:
- **Grok 4.7:** billed ≈ 1.053 × o200k + 1,065 on 22 billed requests (leave-one-out p90 error 2.3%); 4.20 predates 4.7.
- **Kimi K3:** Moonshot's estimate endpoint counts K3 text as `kimi-k2` plus 78 tokens.
- **Claude:** `tool-preamble` per line from [Anthropic's pricing table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing); `base` 9 or 7 and `per-tool` 9 from `count_tokens` probes. Haiku 5.5 counts exactly (the old comment said "nearest").

Decisions:
- Only unanchored estimates are framed; a billed anchor already includes it.
- Window, threshold and band checks frame both sides (compaction projections too); reduction checks stay local on both.
- `claude-opus-45` (Opus 4.5; its collapsed revision parses as 45) still counts in `claude-v5`, as on main: a one-range fix, left out to keep the mapping identical.

Maintenance: an unmeasured line gets no framing and behaves as on main; if xAI changes Grok's tokenizer, the fix is two numbers in `xai.kdl`.

## Testing

- **Replay:** 89 real first requests after a switch, rebuilt by origin/main and this branch, captured and never sent; 88 paired (one timed out on both trees).
- **Fresh session, Opus 5.5, 17 tools:** 40,157 → 40,605 against `count_tokens` 42,126 (−4.7% → −3.6%).
- **Anchored pairs:** 5,074 tool-loop pairs, byte-identical on both trees.
- **Tests:** seeded policies for real ids, every bundled row's tokenizer, compiler rejections, framed vs anchored estimates, `models.yml` models, and on Grok 4.7 snapcompact's checks, the retry fit and the advisor floor; each fails with its change reverted.
- `bun check`: types and lint pass; oxfmt flags two files unformatted on main.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
