## What

Devin now publishes long-context prices for its GPT-5.6 Fast lanes and kept Sol's long-context price when it raised Sol on Nov 21, so I made omp's 272K tiers for GPT-5.6 match what Devin publishes, Fast lanes included.

Before this, a request above 272K input tokens on `devin/gpt-5-6-terra-fast` was costed at the lane's normal $4 / $24 instead of $8 / $36, and one on `devin/gpt-5-6-sol` at $10 / $45 instead of $8 / $30. Above 272K, per million input / output tokens:

| Devin model | Normal price | `main` | This PR (Devin's page) |
|---|---|---|---|
| GPT-5.6 Sol | $5 / $30 | $10 / $45 | $8 / $30, $0.80 cached |
| GPT-5.6 Sol Fast | $10 / $60 | $10 / $60 (no tier) | $16 / $60, $1.60 cached |
| GPT-5.6 Terra Fast | $4 / $24 | $4 / $24 (no tier) | $8 / $36, $0.80 cached |
| GPT-5.6 Luna Fast | $0.40 / $2.40 | $0.40 / $2.40 (no tier) | $0.80 / $3.60, $0.08 cached |

Terra and Luna, standard and Fast, use the existing rule (2x input and cache, 1.5x output of the lane's own price), which gives the page's figures exactly. Sol and Sol Fast carry the page's rates as fixed numbers. Fusion pairings follow their lead.

Because the Fast lanes now have a premium tier, Extended Context applies to them as it does to the standard lanes: off (the default), their window is 272K so compaction runs before a request crosses into the tier; on, they keep 1M. On `main` they stayed at 1M either way.

**Non-goals:** GPT-5.4 and 5.5 Fast and GPT-5.4 mini stay untiered, since Devin publishes no tier for them.

## Why

Devin's long-context tiers come only from its [models page](https://docs.devin.ai/desktop/models), which no Devin endpoint carries, so `devin.kdl` keeps them as exact id lists. That list was written when the page had no Fast tiers. It now lists GPT-5.6 Sol, Terra and Luna Fast at 272K, and the fix adds each Fast lane's id and `-priority` effort uids.

For Sol the multiplier would give $10 / $45 and $20 / $90, but the page publishes $8 / $30 and $16 / $60 and says the Nov 21 change is to standard-context rates: "GPT-5.6 Sol's standard-context rates change on November 21, 2026 at 07:00 UTC from $4 to $5 per million input tokens and from $20 to $30 per million output tokens. Fast mode costs twice those rates."

The Fast lanes' window follows the existing Extended Context rule rather than `long-context-window-uncapped`, which marks hosts whose tier prices are estimates; Devin bills per token, and the Fast lanes would otherwise behave unlike their standard lanes.

Related: #18110

## Testing

- The contract test in `test/devin-discovery.test.ts` that expected no tier on a GPT-5.6 Fast lane now covers the two branches: Terra Fast through the multiplier and Sol at its new price through the published rates. The "no published tier" case gains a GPT-5.5 Fast uid. With the KDL change reverted, the case fails.
- A recorded Devin catalog response through discovery and `buildModel`: the four lanes above and their fusion pairings change as in the table; no other row changes.
- The same response through `ModelRegistry`: with Extended Context off the Fast lanes go from 1M to 272K, like the standard lanes on `main`; on, they keep 1M. GPT-5.5 Fast is unchanged.
- Not run: a billed Devin turn above 272K, so what Devin actually charges there rests on its published page.
- `bun check` passes; `bun test` in `packages/catalog`: 1416 pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
