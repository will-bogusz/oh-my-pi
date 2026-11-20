## What

Some models got another model's snapcompact frame shape because the old id regex matched the wrong part of their name, so I removed the residue that kept those results and let the catalog identity decide.

Snapcompact draws archived history as image frames in the layout the reading model reads best. Since the catalog took over that choice, four groups still kept the old regex's pick through parity residue in `providers/snapcompact-shape.kdl`. Without it, 337 of 7,757 models change, all to their own lineage's shape:

| Models | Before | Now | Why |
|---|---|---|---|
| Devin Fusion pairings led by Claude Opus 5/5.5 (200) | Claude layout, 1568px | Claude layout, 1932px | The lead reads the frames, and Opus 4.7+ reads 1932px natively, as every other Opus 5.5 row already gets |
| Devin Fusion pairings led by GPT with a Claude sidekick (120) | Claude's `11on16-bw` | GPT's `8on22-bw` | The regex matched the sidekick's name; the GPT lead reads the frames |
| OpenAI o-series behind Cloudflare's and Vercel's Anthropic-compatible wire (14) | the Anthropic wire's fallback, `11on16-bw` | OpenAI's `8on22-bw` | The wire fallback is for unknown models; these are OpenAI's |
| Abliteration models the catalog classifies as GLM (3) | the generic `8on22-bw` | GLM's `8on16-bw` | Their ids never said "glm", so the regex missed the lineage the catalog knows |

> **Devin context.** A Fusion pairing is one Devin model id that runs a lead model with a cheaper sidekick, like an OMP main role delegating to a task role. The catalog already classifies each pairing as its lead.

Non-goals: no new measurements and no change to any lineage's own shape. A model's configured `snapcompactShape` still wins over these rules.

## Why

The regex read substrings of the model id. The catalog identity is what prices these frames already (an Opus-led pairing was billed at Opus's high-res tier while rendered at 1568px), so the shape now follows the same identity as the bill. Each fix removes a residue rule; no rule is added.

## Testing

- `resolveShape()` on `main` and this branch for every bundled and locally discovered model (7,757): exactly the 337 rows above differ, nothing else.
- `bun test packages/snapcompact/test/snapcompact.test.ts` (123 pass): added an Opus-led and a GPT-led Fusion pairing to the gateway test; both fail with the residue restored (`Expected: 1932, Received: 1568`).
- `bun test packages/catalog/test` (1,421 pass).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated
