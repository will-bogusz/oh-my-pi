## What

Three Factory Droid models had no list price wired up, so the browser showed only their credit rate and every turn on them cost $0 in omp, so I pointed each at the bundled row Factory prices it like.

Per 1M tokens, input / output / cached input:

| Factory Droid model | `main` | this PR | bundled row it reads |
|---|---|---|---|
| `claude-fable-5.1` | $0 | $10 / $50 / $0.25 | `anthropic/claude-fable-5-1` |
| `glm-5.2-fast` | $0 | $2.10 / $6.60 / $0.21 | `fireworks/glm-5.2-fast` |
| `muse-spark-open` | $0 | $1.25 / $4.25 / $0.15 | `meta/muse-spark-1.2` |

In the model browser the rows go from `4×` / `0.84×` / `0.5×` to `$10/50 4×` / `$2.1/6.6 0.84×` / `$1.25/4.25 0.5×`; the credit rates are unchanged.

**Beyond the browser:** the same price feeds session cost, spending caps and the image-description fallback's cheapest-vision-model pick, which on `main` ranked Fable 5.1 and Muse Spark Open as unpriced. Credit rates, routing and requests are unchanged.

## Why

Factory bills in credits, so its registry rows carry a zero dollar cost and a `list-price-from` in `factory-droid.kdl` that borrows the upstream list price from a bundled row. These three had none, so they kept the zero: session cost counted nothing for them, and the browser showed no price next to models that do have one.

- **Each reference was checked against Factory's own price** for the model before pointing at it: all three bundled rows match exactly.
- **Muse Spark Open borrows Muse Spark 1.2's row.** There is no bundled `muse-spark-open`; Factory prices it the same as 1.2 ($1.25 / $4.25 / $0.15), the row omp's Factory Muse Spark 1.2 already reads.
- **Fable 5.1 names its row** (`claude-fable-5-1`) because the bundled Anthropic id differs from Factory's `claude-fable-5.1`; GLM 5.2 Fast shares its id with the Fireworks row.
- **No new test.** `factory-droid-provider.test.ts` (*prices from the referenced catalog entry*) covers how a reference resolves; per-model tests would only read the KDL back.

Maintenance: a reprice upstream reaches these rows with the next `models.json` regen. If a regen drops a referenced row, the model falls back to $0 as today.

## Testing

- `buildFactoryDroidModel` on `main` and on this branch: cost `{0,0,0,0}` on `main` for all three, the table's values here (Fable 5.1 also gets Anthropic's $12.50 cache write).
- Live turns (`omp -p`, read two files and sum them), `main` → this PR: `factory-droid/claude-fable-5.1` answered 42 at $0 → 42 at $0.0256; `factory-droid/glm-5.2-fast` 42 at $0 → 42 at $0.0095.
- Not run: a live Muse Spark Open turn, since our account does not have it enabled; its price comes from the same lookup as the other two.
- `bun test test/factory-droid-provider.test.ts test/compat-conformance.test.ts` in `packages/catalog`: 53 pass, 1 fail, the *every bundle="always" seed row is bundled* case that fails on `main` too. `bun test test/model-browser.test.ts` in `packages/coding-agent`: 39 pass.
- `bun run gen:compat` regenerated `rules.json`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
