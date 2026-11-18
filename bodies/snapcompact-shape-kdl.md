## What

I moved snapcompact's per-model frame shapes out of a regex table in TypeScript and into the catalog's KDL rules, where the rest of the per-model image policy already lives, without changing the shape any catalog model gets.

Snapcompact draws archived history as image frames, and each reading model gets the frame layout it reads best (glyph cell and frame width). That choice was a first-match regex over the model id in `snapcompact.ts`. It now comes from three catalog rules, resolved through the model's catalog identity on its host, like `image-max-edge`:

| Rule | Sets | Unassigned |
|---|---|---|
| `snapcompact-variant` | the layout of the archive's edge frames | `8on22-bw` |
| `snapcompact-frame-size` | the frame edge, for models that read larger frames at no extra cost (Claude Opus 4.7+/Fable/Mythos: 1932, Gemini: 2048) | the layout's own 1568 |
| `snapcompact-middle-variant` | the denser layout of a long archive's middle | `8on16-bw` |

**Beyond the migration:** a custom model now gets the shape of the lineage the catalog classifies it as, like every other KDL policy. On `main` the regex read only its id: a custom gateway model `my-opus` with `requestModelId: claude-opus-5-5` went from `8on22-bw` at 1568px to Claude's `11on16-bw` at 1932px.

Reading order: `axes.ts`, `classes/*.kdl` (one block per lineage, with its eval evidence), `providers/snapcompact-shape.kdl` (wire fallback and residue), `resolveSnapcompactShape` in `image-tokenization.ts`, then `resolveShape` and `denseCompanion` in `snapcompact.ts`.

Non-goals: no catalog model's shape changes. Later tuning, such as another Gemini frame size on one host, is one KDL rule.

## Why

`AGENTS.md` keeps model-conditional policy out of TypeScript, and this was snapcompact's last such table.

Decisions:
- Three scalar axes, not one object: each cascades on its own, so a host override sets only the frame size.
- The wire fallback (Anthropic Messages and Bedrock read Claude's layout) is an `on-api` rule at `priority=-1`, as `image-tokenization` does it.
- Where the regex and the catalog identity disagree on a catalog model, residue keeps the regex's result. Kimi and GLM rows the taxonomy leaves unclassified (Bedrock, Venice, Umans and others) keep their lineage's shape; four groups the regex misread (Devin Fusion pairings, o-series behind Anthropic-compatible gateways, Abliteration's GLM rows) are commented as parity residue for a follow-up to correct.
- Rejected: matching `*claude*`-style globs on every wire to copy the regex for custom models too, which would move id matching into KDL.

Removed: `idealShapeVariant()` and `IdealShape`; `resolveShape()` covers them.

## Testing

- `resolveShape()` on `main` and this branch for every bundled model plus every discovered-model cache here (Devin, Factory Droid, OpenCode Go, Cursor, OpenRouter, Bedrock, Venice and 41 more providers): 7,498 models, 0 differ in layout, frame size, token estimate or detail hint.
- `bun test packages/snapcompact/test` (121 pass): existing shape tests unchanged, plus the custom `my-opus` case above, which fails on `main` (`Expected: 11, Received: 8`).
- `bun test packages/catalog/test` (1,415 pass); snapcompact suites in `agent`, `coding-agent` and `tui` pass except two `agent-session-snapcompact-no-reduction` cases that fail on `main` here too (a local catalog context window).

---

- [x] `bun check` passes (catalog and snapcompact typecheck, oxlint, oxfmt)
- [x] Tested locally
- [x] CHANGELOG updated
