## What

Cursor's own model pages charge 1.5x output once a GPT-5.6 request goes past 272K input tokens, and omp was still costing those turns at the base output rate, so I moved the six cards to the published numbers.

Output above 272K on Cursor's GPT-5.6 models, per million tokens, before → after:

| Model | ≤272K output | >272K output, main | >272K output, this PR |
|---|---|---|---|
| `gpt-5.6-sol` | $20 | $20 | $30 |
| `gpt-5.6-sol-fast` | $40 | $40 | $60 |
| `gpt-5.6-terra` | $12 | $12 | $18 |
| `gpt-5.6-terra-fast` | $24 | $24 | $36 |
| `gpt-5.6-luna` | $1.2 | $1.2 | $1.8 |
| `gpt-5.6-luna-fast` | $2.4 | $2.4 | $3.6 |

Only the output leg of each `long-context-cost` card in `providers/cursor.kdl` moves; input, cache read and cache write above 272K already matched the pages, and nothing at or below 272K changes. Non-goals: Sol's promotional base rate and every other Cursor model stay as they are.

## Why

Each model's Cursor page lists its long-context rows and states the rule: "When input exceeds 272k tokens (long context), input pricing doubles and output pricing is 1.5x the standard rate", with the same multipliers on Fast mode ([Sol](https://cursor.com/docs/models/gpt-5-6-sol), [Terra](https://cursor.com/docs/models/gpt-5-6-terra), [Luna](https://cursor.com/docs/models/gpt-5-6-luna); each page carries its Fast rows). The cards charged what the [models and pricing table](https://cursor.com/docs/models-and-pricing) notes say ("2x input pricing", output unstated), so the cost omp shows for a long Cursor session on any of these models left out a third of the output charge. OpenAI's own GPT-5.6 card in `providers/openai.kdl` already uses $30 above 272K.

The cards stay as absolute rates, like every other card in `providers/cursor.kdl`, rather than switching this family alone to `multiplier` with `output-multiplier 1.5`. If Cursor changes a rate, the fix is the same one-number edit per card.

The bundled Cursor rows in `models.json` are not regenerated here, because `gen:models --provider cursor` rebuilds the roster from the signed-in account; they take the new rate at the next catalog regeneration.

Related: #18110 (long-context tiers for GPT-6.1 Sol on other hosts) and #16183 (Cursor's Teams token rate); neither touches these cards.

## Testing

- `buildModel` on a zero-cost Cursor discovery spec for each of the six ids, before and after: the ≤272K card and the >272K input and cache legs are identical; only the >272K output changes, to the values in the table.
- `packages/catalog/test/cursor-pricing.test.ts`, "models the GPT-5.6 272K long tier: 2x input and cache, 1.5x output", now expects Sol's long-context output at $30. With the KDL change reverted (and `rules.json` regenerated) it fails on `output: 30` vs `20`; with it, the file passes 7/7, and `bun test packages/catalog/test` passes 1416/1416.
- Not run: a billed Cursor turn above 272K, since the rate comes from Cursor's published pages and such a turn costs several dollars.

```sh
bun test packages/catalog/test/cursor-pricing.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
