## What

Devin's Gemini promos all have end dates, but omp was showing the promo price as if it were permanent, so I gave each one a dated card that flips to list price when the promo ends.

Before this, `devin/gemini-4-carbon` would keep showing and billing $2/$10 after 2026-11-24 16:00 UTC, when Devin starts charging $4/$20. Now each request is priced at the rate in force when it was made:

| Devin model | Promo (as reported today) | List, from |
|---|---|---|
| Gemini 3.7 Flash, 3.8 Flash | $0.75 / $3.75, $0.075 cached | $1.50 / $7.50, $0.15 cached, from 2027-01-01 08:00 UTC |
| Gemini 4 Argon | $2 / $10, $0.10 cached | $4 / $20, $0.20 cached, from 2026-12-01 08:00 UTC |
| Gemini 4 Carbon | $2 / $10, $0.10 cached | $4 / $20, $0.20 cached, from 2026-11-24 16:00 UTC |

Prices are per million input / output tokens. Nothing else on Devin changes, Gemini 4 Hydrogen and Gemini 3.6 Flash included.

**Non-goals:** Gemini 4 Hydrogen also has a promo end date (2026-11-26), but its price hasn't changed and no list price is published, so there's nothing to put on a card. SWE-2 Fast's promo has no published list price either.

## Why

Devin's model catalog (`GetCliModelConfigs`) reports each of these models at its promo rate, along with the promo's end date, but it doesn't report the list price. omp reads the rate and has no reason to change it, so the promo price stayed in the model browser and in usage cost after the promo ended.

The fix reuses the dated-pricing rule `devin.kdl` already applies to SWE-2: a `cost-patch` that pins the promo rate, plus an `effective-rates` `list-price` card dated at the end of the promo. The end dates come from the catalog. The list prices for Flash and Argon come from [Devin's model docs](https://docs.devin.ai/desktop/models), which state both the promo and the regular price. The docs don't list Carbon, so its list price is the $4 / $20 / $0.20 the catalog reported for Carbon before the promo began, which is also Argon's.

Decisions:
- **Pinning the promo rate as well as the card.** With only the card, a row rebuilt after the end date (when the catalog already reports list) would also bill earlier requests at list. This follows the same Argon card in `classes/gemini.kdl`, which is scoped to Google's own hosts and so doesn't reach Devin.
- **Flash goes through the class rank** (`gemini` / `flash` / `>=3.7 <3.9`). Argon and Carbon share a rank with Hydrogen and have no family, so they're exact id lists (the logical id plus raw effort uids, as for SWE-2).

**Maintenance:** each card stops mattering once its date passes and can be deleted then. If Devin extends a promo, omp shows list price too early. The catalog's new end date shows that, and the fix is a one-line date change.

## Testing

- A new case in `test/devin-discovery.test.ts` builds each model from the promo price discovery reports. It checks the promo rate one millisecond before each end date and list at it. It also checks that Hydrogen and Gemini 3.6 Flash keep their reported price with no schedule. With the KDL change reverted, the case fails on the first row.
- The catalog I fetched today, run through omp's Devin discovery and `buildModel`: on `main` every Gemini promo price stays the same after its date. On this branch Flash, Argon and Carbon switch to the list prices above, and Hydrogen and 3.6 Flash don't change.
- `bun test` in `packages/catalog`: 1405 pass. `bun run check` in `packages/catalog` passes.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
