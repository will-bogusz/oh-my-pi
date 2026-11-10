## What

Devin stopped serving SWE-1.6 Fast weeks ago, but omp still ships it as a built-in Devin model, so I removed it.

Before Devin's live model list loads (first start, or when Devin can't be reached), omp lists the Devin models it ships with:

| `omp models find swe-1-6` with Devin unreachable | `main` | this PR |
|---|---|---|
| Devin rows | `swe-1-6`, `swe-1-6-fast` | `swe-1-6` |

Once the live list loads, `main` already drops it: `omp -p --model devin/swe-1-6-fast` reports `Model "devin/swe-1-6-fast" not found`. So the row only ever showed a model that can't run.

## Why

Devin's model list (`GetCliModelConfigs`) returns every model for every plan, disabled ones included, and `swe-1-6-fast` has been absent from it since October; `swe-1-6` and `swe-1-6-slow` remain. The built-in seed in `devin.kdl` is what omp shows before that list arrives, so it should only carry models Devin still serves.

- **The default stays `swe-1-6`**, which is still served; nothing about the account default changes.
- **`models.json` regenerated for Devin only** (`bun run gen:models --provider devin`): the decoded catalog differs from `main` by that one row.
- **The SWE-1.6 image workaround keeps `swe-1-6`** and drops the retired id; the Fusion comment that used `swe-1-6-fast` as its example now names a live uid.

## Testing

- `omp models find swe-1-6` with Devin unreachable (requests sent to a dead proxy): `main` lists `swe-1-6` and `swe-1-6-fast`, this branch lists `swe-1-6` only. With Devin reachable both list the same live models.
- Live `devin/swe-1-6-slow` turn from this branch (read two files, reply with their sum): answered 42.
- `cd packages/catalog && bun test`: 1351 pass. `cd packages/ai && bun test test/devin*.test.ts`: 67 pass. `cd packages/coding-agent && bun test test/provider-default-selection.test.ts`: 7 pass.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
