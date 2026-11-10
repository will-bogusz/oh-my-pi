## What

I added the Factory Droid models droid 1.7.1 serves and caught Muse Spark 1.3 up with its new image support, so an account entitled to them can pick them in omp.

| In omp on a Factory login | `main` | This PR |
|---|---|---|
| Claude Fable 5.2 | missing | listed when the account's `claude_fable_5_2` flag and the Fable data-retention opt-in allow it; Anthropic upstream only, Low…Max (default High, no Off), 867K/128K, 3.2× input credits, Anthropic's list price beside them |
| Gemini 4 Carbon | missing | listed behind `gemini_4_carbon`, Global inference only, Low/Medium/High (default Medium), 934K/66K, 1.6× input credits, **0.8× until 2026-12-01 08:00 UTC**; Argon's request rules (no sampling params, output cap pinned, Gemini's own turns replayed natively) |
| Kimi K3.1 Pro | missing | listed behind `kimi_k3_1_pro` on Droid Core, Fireworks/Baseten/Databricks (US: Baseten), Low/High/Max (default Max), 869K/131K, images, Kimi Code's list price; tool results carry the tool name as Kimi K3's do |
| `image` role, Factory defaults | GPT Image 2.5, 2.5 Flare, Gemini 3 Pro Image | GPT Image 2.6 and 2.6 Flare first, then the same three |
| Muse Spark 1.3 image input | image dropped (or described by another model) | image sent; hidden only by the account's region, not by its retired feature flag |

> **Factory context.** Factory has no model-listing endpoint: omp ships the CLI's roster in `factory-droid.kdl` and narrows it per account with feature flags, org policy and inference region. A credit promotion is two dated `effective-rates` cards, so the rate switches back on its own date.

Reading order: the seed rows, then the per-model `models` blocks in `factory-droid.kdl` (Fable 5.2 above Fable 5.1, Carbon above Argon, Kimi K3.1 Pro above Kimi K3, the image block) → the dialect lines that gained an id (`disabled-thinking "adaptive"`, `requires-tool-result-name`, Argon's `google-*` lines) → `quota-tiers`, `api-routes` and `role-defaults "image"` in `runtime/behavior.kdl`.

## Why

droid 1.7.0/1.7.1 add these models and retire Muse Spark 1.3's gate (its flag is deprecated, served only for older clients). Each new model reuses an existing rule axis; Fable 5.2 is prefix-bound, so it gets `drop_block` on the direct Anthropic upstream like Opus 5.5.

Decisions:
- Carbon gets no list price: Google has published none, and borrowing Argon's row would show Argon's introductory price.
- Muse Spark 1.3 gains image input only: droid also enables PDF, but omp's model `input` has no PDF modality to set.
- GPT Image 2.6's new `complexity` and GIF controls are left out; its default request matches 2.5's.

Maintenance: the Carbon card ends by itself on 2026-12-01; the next sync round drops it.

## Testing

- Live on a Factory login from this branch, `omp -p` two-read turn (read two files, reply with their sum): 42 on `claude-fable-5.2`, `gemini-4-carbon` and `kimi-k3.1-pro`.
- One-image turn on `muse-spark-1.3` (a red/blue split PNG): this branch sends the image and the model answers RED/BLUE; the base branch drops it and the model says it got no image.
- `generate_image` with the `image` role set to `factory-droid/gpt-image-2.6-sunburst` returned a generated image, reported as `gpt-image-2.6-sunburst`.
- Native parity: droid 1.7.1 captures for `claude-fable-5.2@anthropic`, `gemini-4-carbon@google` and `kimi-k3.1-pro@fireworks` match omp's requests (`factory-droid-native-parity.test.ts` 64 pass). With Carbon removed from Argon's dialect line its parity case fails; with Kimi K3.1 Pro removed from `requires-tool-result-name` the new completions test fails.
- Discovery tests now check that the three new flags gate their models and that Muse Spark 1.3 is listed with its flag off and carries image input.
- `bun test` (`env -i`): `packages/ai` Factory tests 303 pass; `packages/catalog` Factory and compat tests 209 pass, 1 fail (`compat-conformance` "every bundle=\"always\" seed row…", failing on `main` too); `packages/coding-agent` image-gen and image-budget tests 92 pass. `check:types` clean for all three.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

