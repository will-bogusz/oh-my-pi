## What

Factory is running Gemini 4 Argon at half its credit rate until the end of November, and omp's model browser was still showing the full 1.6×, so I added the promotion's two dated rate cards.

On Factory Droid, Argon's row now reads **1.6× → 0.8×** until 2026-12-01 08:00 UTC (midnight US Pacific), then 1.6× again on its own.

| `factory-droid/gemini-4-argon` in the model browser | `main` | this PR |
|---|---|---|
| Now (2026-11-10) | `$2/10 1.6×` | `$2/10 0.8×`, detail `· 1.6× from 2026-12-01` |
| 2026-12-01 07:59:59 UTC | `$2/10 1.6×` | `$2/10 0.8×` |
| 2026-12-01 08:00 UTC | `$4/20 1.6×` | `$4/20 1.6×`, no dated note |

The dollar column is Google's list price, which already moves to $4/$20 on 12-01 through its own dated cards; this PR changes only the credit rate.

## Why

Factory bills Argon at 0.8× from 2026-10-13 16:00 UTC through November 30 Pacific. omp already models Factory promotions as two dated `effective-rates` cards on a model's `credit-rates` in `factory-droid.kdl` (GPT-5.6 Sol, Gemini 3.8/3.7 Flash); Argon was missing its pair, so the browser overstated its cost by 2× for the whole promotion.

- **Input rate only.** Factory's promotion discounts the input credit weight; the output (5) and cache-read (0.05) weights stay as they are, the same shape as the Sol and Flash cards.
- **No new test.** The dated-card path is covered by `factory-droid-provider.test.ts` (*dated credit rates*) and `model-browser.test.ts` (*Factory Droid dated credit rates over time*); a test of Argon's row would only read the KDL back.

Maintenance: none when the promotion ends, since the `standard` card restores 1.6× at its timestamp. If Factory extends it, move that card's `effective-from`.

## Testing

- Model browser built from the real registry row under `setSystemTime` at 2026-10-13 15:59:59Z, 2026-11-10, 2026-12-01 07:59:59Z and 08:00Z: 1.6× (detail `0.8× from 2026-10-13`), 0.8×, 0.8×, 1.6× with the $4/20 list price. `main` shows 1.6× on 2026-11-10.
- Live turn on `factory-droid/gemini-4-argon` (`omp -p`, read two files and sum them): answered 42.
- `bun test test/factory-droid-provider.test.ts test/compat-conformance.test.ts test/time-based-pricing.test.ts` in `packages/catalog`: 74 pass, 1 fail, the *every bundle="always" seed row is bundled* case that fails on `main` too. `bun test test/model-browser.test.ts` in `packages/coding-agent`: 39 pass.
- `bun run gen:compat` regenerated `rules.json`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
