## What

I bumped the Devin pin to 3000.12.43 since that's the CLI Devin ships now, and omp was still introducing itself as 3000.11.205.

Devin chat, model assignment and `/usage` requests now identify as CLI 3000.11.205 → 3000.12.43. The identity is one constant (`DEVIN_CLI_METADATA` in `packages/catalog/src/wire/devin.ts`); the `devin-cli` / `chisel` names and model discovery's separate identity are unchanged.

## Why

Devin's backend gates behaviour on the client version a request carries, and 3000.11.205 is now three stable releases behind (3000.11.228, 3000.11.234 and 3000.12.17 shipped since). Today's official CLI sends the same `devin-cli` / `chisel` identity with 3000.12.43 in both version fields, and its first chat request has the same fields as 3000.11.205's, so this is the version string only.

Non-goals: the model list is served by Devin's backend, not the CLI, so the models added since (Claude Fable 5.2, Gemini 4 Carbon, Kimi K3.1 Pro, SWE-2 Flash and others) already reach omp's picker on `main`; nothing here changes discovery.

Maintenance: the pin is hand-maintained. The current release is `version` in `https://static.devin.ai/cli/current/manifest.json`; bumping it is this same change.

## Testing

- Live, `devin/swe-1-6-slow`, from this branch: a tool-using turn (read `a.txt` and `b.txt`, reply with the sum) answered `42`; the second request read 19,424 cached tokens.
- Live, `devin/swe-2-flash` (the free plan's default model now): the same turn answered `42`.
- A request captured from omp on this branch carries the same identity fields as one captured from the official 3000.12.43 CLI.
- `cd packages/ai && bun test test/devin*.test.ts`: 67 pass. `cd packages/catalog && bun test test/devin*.test.ts`: 38 pass. The two `packages/ai` tests pin the sent version and fail against the old constant.
- Not run: paid-plan models, since the account available is on the free plan.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
