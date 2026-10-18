## What

The model browser was telling Factory Droid users GPT-5.6 Sol costs 2× credits while Factory is billing it at 1.6× during its current promotion, so I taught the catalog about dated credit discounts and the browser now shows the rate actually being charged.

Model browser at 110 columns, 2026-10-18:

| | `main` | This PR |
|---|---|---|
| `gpt-5.6-sol` row | `$4/20 2×` | `$4/20 1.6×` |
| `gemini-3.8-flash` row | `$0.75/3.75 0.6×` | `$0.75/3.75 0.3×` |
| `claude-opus-5-5` row (no promotion) | `$4/20 1.6×` | `$4/20 1.6×` |
| detail line | `… $4/20 2× per M · reasoning · vision` | `… $4/20 1.6× per M · reasoning · vision · 20% off until 2026-11-22` |

**Schema addition (your call):** this adds a dated pricing field to the catalog schema, a `credit-promotion` axis on Factory Droid models (example below).

It is display-only: `/usage` numbers come from Factory's billing endpoint and nothing omp sends to Factory changes.

Non-goals: other providers, fetching promotions live (Factory has no endpoint for them), the dollar list price beside the rate.

<details><summary>Reading order and KDL example</summary>

```kdl
credit-rates { input 2; output 5 }
credit-promotion { discount 0.2; starts "2026-08-22T00:00:00Z"; ends "2026-11-22T00:00:00Z"; label "20% off" }
```

- `credit-promotion` in `compat/axes.ts`, validated by `creditPromotionValue` / `collectAxis` in `scripts/compat-compiler/compile-axes.ts`
- `readPolicy` → `FactoryDroidCreditPromotion` in `compat/factory-droid.ts`; `buildFactoryDroidModel` copies it onto the model
- `getFactoryDroidCreditRate` in `catalog/src/models.ts` (window check, discount)
- `withCreditBadge` / `creditPromotionNote` in `tui/src/overlays/model-browser.ts`
- the five `credit-promotion` lines in `providers/factory-droid.kdl`

</details>

## Why

Factory runs time-boxed credit discounts on top of each model's multiplier. omp shows that multiplier only in the model browser, which overstated GPT-5.6 Sol (and Fast) by 25% and Gemini 3.7/3.8 Flash and Mistral Large 4 by 2×.

Decisions:
- The model keeps the base rate plus the promotion window, and the browser applies the discount against the clock when it renders. Baking the discount in at discovery was rejected: cached and offline models would keep it past the end.
- A separate axis rather than a child of `credit-rates`, so adding a promotion never rewrites the base rates. It must follow `credit-rates` in its block.
- Row cells show only the rate; the label and end date go last in the detail line and in the preview, so narrow widths cut them before reasoning, vision or speed facts.

Maintenance: promotions are hand-entered, one KDL line each; a malformed one fails `gen:compat` with file and line. Mistral Large 4's launch discount ends 2026-10-20; after that the line is inert.

## Testing

- Compiler: a valid promotion compiles; 10 malformed ones fail at their line (discount 0 or ≥ 1, end before start, `2026-02-30`, `24:00`, non-ISO or non-UTC dates, missing or empty label, unknown key), as does a promotion without `credit-rates`.
- Window: discounted at the start, base rate 1 ms before it and at the end.
- Cache: discover online inside a registry promotion's window, move the clock past the end, then resolve offline and with Factory failing: both return the cached model and it reads the base rate with no promotion.
- Browser at 80 and 120 columns: row shows `$1.25/10 1.6×` without the label and the detail keeps `reasoning · vision`; at 160 the detail ends `· 20% off until …`; an ended promotion shows `2×` and no label. Picker column stays `$3·15 1.6×`.
- Negative control: against the first commit's code (discount baked in at discovery), the browser and picker tests fail; against `main`, the catalog tests fail as well.
- Suites: catalog 1228 / 0; tui 3939 pass, 7 skip, 1 fail (`terminal background SIXEL repaint`, which fails the same way on `main`); `model-browser.test.ts` 34 / 0; `bun run check:ts` clean.

<details><summary>Re-run</summary>

```sh
bun test packages/catalog/test/compat-compile.test.ts packages/catalog/test/factory-droid-provider.test.ts
bun test packages/coding-agent/test/model-browser.test.ts packages/tui/test/model-picker-native.test.ts
```

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
