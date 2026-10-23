## What

Every Devin model shows up as 200K in omp, the `-1m` lanes too, because discovery reads a context field Devin's catalog mostly leaves empty, so I pointed it at the per-model one it actually fills.

Devin context windows in `/models` and compaction go from 200K on every model to each model's own limit: 200K → 1M for Claude Opus 5.5 and the `-1m` lanes, 262K for SWE-2, 1,048,576 for Kimi K3.

| Devin model | `main` | This PR | This PR, `/extended-context on` |
|---|---|---|---|
| `claude-opus-4-6` / `claude-opus-4-6-1m` | 200K / 200K | 200K / 1M | same |
| `glm-5-2` / `glm-5-2-1m` | 200K / 200K | 200K / 1M | same |
| `claude-opus-5-5` | 200K | 1M | same |
| `swe-2` | 200K | 262K | same |
| `kimi-k3`, `gemini-4-argon` | 200K | 1,048,576 | same |
| `gpt-6-sol` | 200K | 272K | 1M (was 200K) |
| `grok-4-7` | 200K | 200K | 500K (was 200K) |
| `swe-1-6-slow` | 200K | 200K | same |

> **Devin context.** Each config in Devin's `GetCliModelConfigs` has a top-level `max_tokens` and a nested `model_info.max_tokens`. `devinModelSpec` (`discovery/devin.ts`) read only the top-level one, else 200K; it now falls back to `model_info`'s before 200K.

## Why

In the live catalog (2026-10-23, 837 configs), the top-level `max_tokens` is set on 4 (`swe-1-6-slow` and three internal helpers, all 200000). `model_info.max_tokens` is set on 834 and is where lanes differ: `claude-opus-4-6` 200000 against `claude-opus-4-6-1m` 1000000, `grok-4-7` 500000. The 2026-10-06 catalog has the same shape. So on `main` the `-1m` lanes look identical to their 200K siblings, and every Devin session compacts at 200K.

The values agree with other providers' rows for the same models (`anthropic/claude-opus-5-5` 1M, `moonshot/kimi-k3` 1,048,576, `openai/gpt-6-sol` 1.05M). Devin's existing long-context price tiers in `devin.kdl` (GPT ≥272K, Grok and Gemini Pro >200K) now apply as written: those models start at the threshold and `/extended-context on` opens the full window. On `main` the toggle did nothing for Devin.

Decision: the top-level field still wins when set; the 4 configs that set it agree with their `model_info`.

Maintenance: if Devin moves the field again, windows fall back to 200K, today's behaviour. The cache namespace moves to `devin:models-v3`, as the v2 Fusion fix did, so a cache from before the upgrade refetches instead of serving 200K rows for up to its 2 h TTL.

## Testing

- Rendered the captured 2026-10-23 catalog (every row enabled, as a paid account sees it) through a real `ModelRegistry` with `/extended-context` off and on, on `main` and this branch: the table above. On `main` all 13 sampled models are 200K both ways.
- Live turn on `devin/swe-1-6-slow` (the only model this Free account runs): read `a.txt`, then `b.txt`, reply with the sum. Three assistant turns, answer `7`, window 200K as before. Not run: a >200K turn, which needs a paid account.
- New tests in `devin-discovery.test.ts`: "takes the context window from modelInfo.maxTokens…" fails with the `devin.ts` change reverted (`Expected: 1048576, Received: 200000`); "refetches a catalog cached before context windows came from modelInfo" fails with the namespace bump reverted (0 fetches, the 200K cache served).
- `packages/catalog` `bun test`: 1246 pass; root `bun run check:ts` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
