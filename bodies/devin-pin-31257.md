## What

I bumped the Devin pin to 3000.12.57 since that's the CLI Devin ships now, and omp was still introducing itself as 3000.12.43.

Devin chat, model assignment and `/usage` requests now identify as CLI 3000.12.43 → 3000.12.57. The identity is one constant (`DEVIN_CLI_METADATA` in `packages/catalog/src/wire/devin.ts`); the `devin-cli` / `chisel` names and model discovery's separate identity are unchanged.

## Why

omp should introduce itself as the CLI Devin currently ships, and `https://static.devin.ai/cli/current/manifest.json` now serves 3000.12.57. Today's official CLI sends the same `devin-cli` / `chisel` identity with 3000.12.57 in both version fields, and its first chat request has the same fields, headers and tool list as 3000.12.43's, so this is the version string only.

Non-goals: the model list is served by Devin's backend, not the CLI, so nothing here changes discovery.

Maintenance: the pin is hand-maintained. The current release is `version` in `https://static.devin.ai/cli/current/manifest.json`; bumping it is this same change.

## Testing

- Live, `devin/swe-1-6-slow`, from this branch: a tool-using turn (read `a.txt` and `b.txt`, reply with the sum) answered `42`; the second request read 18,656 cached tokens.
- Live, `devin/swe-2-flash` (the free plan's default model): the same turn answered `42`.
- A chat request from this branch carries the same identity fields as the official 3000.12.57 CLI's.
- Today's server model list rendered through this branch's discovery matches `main` row for row, including the newly served Gemini 4 Hydrogen (`gemini-4-hydrogen`, low through xhigh).
- `cd packages/ai && bun test test/devin*.test.ts`: 68 pass. `cd packages/catalog && bun test test/devin*.test.ts`: 38 pass. The two `packages/ai` tests pin the sent version and fail against the old constant. `check:types` passes in `packages/ai` and `packages/catalog`.
- Not run: paid-plan models, since the account available is on the free plan.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
