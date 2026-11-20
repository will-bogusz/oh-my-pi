## What

I measured what Devin bills per image for the rest of its Gemini models, and Gemini 4 Hydrogen and Argon and Gemini 3.5 and 3.8 Flash all bill the same flat ~1,089 tokens as Carbon and Neon, so this marks them verified and their snapcompact archives stop dropping history that fits.

A compaction of 1.54M characters at a 300K-token trigger on `devin/gemini-4-hydrogen` keeps 26 frames and drops 721K characters on `main`; with this PR it keeps 48 frames and drops nothing.

> **Snapcompact context.** Compaction draws old history into PNG frames and caps how many it keeps by what they will cost in tokens. A reader whose image price is `verified` in the catalog is charged that price per frame; any other reader is charged a 5,024-token planning estimate.

The change is in `devin.kdl`: the Flash rule's revision range widens to `>=3.5 <3.6` and `>=3.7 <3.9`, and Hydrogen and Argon, with their raw effort uids, join Carbon and Neon's verified id list.

## Why

The rule's own comment kept 3.5/3.8 Flash and 4 Hydrogen/Argon on the unverified lineage rule "until measured"; this is that measurement.

Measured on Devin's own host at low effort, billed input minus each model's no-image baseline:

| Model | One image at 8 sizes, 512–4,096 px (9 calls) | Real `8on22-bw` frames, N = 0–8 (slope) |
|---|---|---|
| Gemini 4 Hydrogen | 1,088–1,092 | 1,091.0 ± 0.2 per frame (20 calls) |
| Gemini 4 Argon | 1,088–1,091 | 1,091.0 ± 0.1 per frame (18 of 20 calls, below) |
| Gemini 3.5 Flash | 1,087–1,090 | 1,088.8 ± 0.1 per frame (10 calls) |
| Gemini 3.8 Flash | 1,088–1,089 | 1,088.9 ± 0.3 per frame (10 calls) |
| Gemini 4 Neon (already verified) | 1,092–1,095 | 1,091.0 ± 0.2 per frame (10 calls) |

**Argon anomaly.** Two of the 20 Argon frame calls billed about 416 tokens more than repeats with the same images (prompts differ only by a nonce), the same excess at 1 and 2 frames, which is consistent with a per-request offset rather than a per-image price. The other 18 calls give 1,091.0 ± 0.1 per frame; all 20 give 1,083.2 ± 20.1. No other model showed it (0 of 50 frame calls). It does not change the per-frame budget.

Decisions:
- **3.6 Flash stays unverified.** It was not measured; the test pins it on the lineage rule.
- **An id list for Gemini 4, not a class rule.** All four Gemini 4 models now share one price, but a bare `revision ">=4 <5"` would also verify any later Gemini 4 model on Devin without a measurement.
- **1,089, the rule's existing value.** Each of the four bills within 3 tokens of it, under 0.3% of a frame.

## Testing

- **Live billing**, the table above, through omp's Devin transport.
- **Frames kept.** A real `session.compact()` over 280 turns (1.54M characters), 1M-token window, 300K trigger: before this change Hydrogen, Argon, 3.5 Flash and 3.8 Flash each plan 5,024 tokens per frame, keep 26 frames and drop 720,896 characters; with it each plans 1,089, keeps 48 and drops nothing. Raw effort uids (`-xhigh`, `-low`) match their logical ids. 3.6 Flash stays at 26 frames; Carbon is 48 on both.
- `bun test packages/catalog/test/image-tokenization.test.ts`: 24 pass. With `devin.kdl` reverted and `gen:compat` rerun, every added id resolves to the unverified `tokens: 1120` rule and the Devin row fails.
- `bun test packages/catalog`: 1,421 pass. `check:types` for `packages/catalog` passes; `bun check` fails on `main` itself (`oxfmt --check` on 20 browser-relay and collab-web files), so its box stays unticked.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
