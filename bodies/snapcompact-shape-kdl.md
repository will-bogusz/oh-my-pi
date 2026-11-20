## What

I moved snapcompact's per-model frame shapes out of a regex table in TypeScript and into the catalog's KDL rules, where the rest of the per-model image policy already lives, without changing the shape any built catalog model gets.

Each reading model gets the frame layout it reads best. That was a first-match regex over the model id in `snapcompact.ts`; it now comes from two catalog rules, resolved through the model's catalog identity on its host, like `image-max-edge`:

| Rule | Sets | Unassigned |
|---|---|---|
| `snapcompact-variant` | the layout of the archive's frames | `8on22-bw` |
| `snapcompact-frame-size` | the frame edge, for models that read larger frames at no extra cost (Claude Opus 4.7+/Fable/Mythos: 1932, Gemini: 2048) | the layout's own 1568 |

The catalog is the bottom layer under #19591's per-model field (by ryanskidmore), as with `image-count-budget`, where a configured `Model` field wins over the axis:

| `resolveShape()` takes, first match | Set by |
|---|---|
| an explicit `snapcompact.shape` setting | the user |
| the model's `snapcompactShape`, with its frame size or the variant's own | models.yml, `modelOverrides`, an extension |
| these rules (the regex on `main`) | the catalog, per lineage and host |
| `8on22-bw` | default |

`image-max-edge` still caps every frame, and billing still follows the reader's image rule. The denser middle of a long archive stays `8on16-bw` for every reader, as on `main`.

**Beyond the migration:** a custom model now gets the shape of the lineage the catalog classifies it as. On `main` a gateway model `my-opus` with `requestModelId: claude-opus-5-5` got `8on22-bw` at 1568px; here it gets Claude's `11on16-bw` at 1932px.

Reading order: `axes.ts`, `classes/*.kdl` (with eval evidence), `providers/snapcompact-shape.kdl` (wire fallback and residue), `resolveSnapcompactShape` in `image-tokenization.ts`, then `resolveShape` in `snapcompact.ts`.

## Why

`AGENTS.md` keeps model-conditional policy out of TypeScript, and this was snapcompact's last such table. `snapcompactShape` is one user's override for one model; the rules are omp's defaults, which nobody should have to configure.

- Two scalar axes, not one object: each cascades on its own, so a host override sets only the frame size.
- The wire fallback (Anthropic Messages and Bedrock read Claude's layout) is an `on-api` rule at `priority=-1`, as `image-tokenization` does it.
- Where the regex and the catalog identity disagree on a catalog model, residue keeps the regex's result; four groups the regex misread (Devin Fusion pairings, o-series behind Anthropic-compatible gateways, Abliteration's GLM rows) are commented for a follow-up.
- Rejected: `*claude*`-style globs on every wire, which would move id matching into KDL.

Removed: `idealShapeVariant()` and `IdealShape`.

## Testing

- `resolveShape()` on `main` and here for every bundled model plus every discovered-model cache on this machine (48 providers): 7,757 built models, 0 differ in layout, frame size, token estimate or detail hint, with or without a configured `snapcompactShape`. A target without catalog identity (`{ api, id }`, even with `provider`) can differ: 563 ids, 525 of them Devin Fusion. omp's callers pass the built model.
- `bun test packages/snapcompact/test` (123 pass), including `my-opus` (fails on `main`: `Expected: 11, Received: 8`) and a configured shape beating Opus 5.5's 1932px rule (fails with the two swapped).
- `bun test packages/catalog/test` (1,421 pass); `coding-agent` and `tui` snapcompact suites pass but two cases that fail on `main` too.

---

- [x] `bun check` passes (catalog and snapcompact typecheck, oxlint, oxfmt)
- [x] Tested locally
- [x] CHANGELOG updated
