## What

I gave DeepSeek V4.1 Flash its own image-cost rule, measured against what OpenRouter bills for it, because omp was pricing each snapcompact frame at Claude's rate and compacting DeepSeek sessions far too early.

A 25-frame archive now counts about 25k tokens instead of 78k, so after a compaction omp's context estimate sits about 20k above what DeepSeek bills instead of 71k above (median over 201 turns of a real OpenRouter session).

| Per 1568px snapcompact frame | `main` | This PR | Billed |
|---|---|---|---|
| via OpenRouter (Anthropic-wire fallback) | 3,136 | 994 | 994 |
| via Fireworks, Together, DeepSeek API, … (OpenAI-wire fallback) | 2,882 | 994 | 994 on Fireworks, 995 on Together |

> **DeepSeek V4.1 Flash image context.** The model's vision encoder cuts an image into 14px patches and merges each 3×3 block into one token, plus one token per row and two delimiters; images under 544² are upscaled first, and anything over 1,024 tokens is shrunk to fit. A large frame therefore costs at most ~1k tokens, a third of Claude's high-res tier.

## Why

With no `image-tokenization` rule, frames fell back to the wire's estimate, and the compaction trigger takes the larger of provider usage and that estimate. In one OpenRouter session compactions fired at 167k–204k billed tokens against a 300k setting; OpenRouter's metadata for the turn after the first archive shows 24 images in 59,641 prompt tokens where omp counted 112,062.

The formula is the vendor's algorithm, so it is TS (a `deepseek-patch` regime next to `openai-patch` and `anthropic-patch`); the numbers are policy, so they are KDL (`classes/deepseek.kdl`, `family "flash"`, `revision ">=4.1 <4.2"`), marked `verified`. Rejected: `fixed` 994, wrong for short frames (1568×784 bills 743) and small images (184).

Scope: V4.1 only; later Flash releases and hosts still serving the V4.0 vision preview keep their fallback. DeepSeek's API serves the retired `deepseek-v4-flash-vision-exp` id with V4.1 Flash, so it gets the rule there. Frame shape and archive size are unchanged (the frame-bytes budget capped these at 26 frames).

Maintenance: a new DeepSeek `vision_config` means new KDL numbers; the measured-table test flags drift.

## Testing

Billing: one OpenRouter request per image with the upstream pinned, input tokens minus a text-only baseline. Fireworks (13 sizes, 256² to 4000², plus 1568×784, 784×1568, 3000×1000, 2576×1716) and DeepInfra (6 sizes) match the formula exactly; Together is +1 on all 6.

Estimate: replayed every turn of the session above through `Tokenizer.countMessages` on `main` and on this branch; local estimate minus billed prompt, median: before any archive −8.7k on both; after an archive +71.3k on `main`, +19.8k here. The rest is the local text tokenizer counting DeepSeek text ~1.3× high, as before any archive.

Read-back: 3 runs, one frame each holding 3 random codes: the model returned 8 of the 9 codes, 2 exactly and 6 with one to three misread characters (`Z`→`2`, `B`→`8`); with no image it answered NONE. It reads frames, lossily.

Negative control: with the catalog source reverted, 4 tests fail.

```
bun test packages/catalog/test/image-tokenization.test.ts packages/snapcompact/test/snapcompact.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
