## What

I made Factory Droid requests keep inline images under 3.5 MB, the Droid CLI's budget under Factory's 4.5 MB request limit, while the newest message's and newest tool result's images stay if they alone fit that limit.

omp already capped Factory at 5 images (the default count budget), but had no byte budget, and five large screenshots can exceed 4.5 MB. `[INFERENCE]` That likely explains the 413s seen on screenshot-heavy Factory sessions; our transcript sizes are an upper bound, not wire captures.

- `factory-droid.kdl`: `inline-image-byte-budget 3500000` (the axis Anthropic and Codex use) and a new `request-body-byte-limit 4500000`.
- Gate: host budgets applied only under `reachesOfficialEndpoint()`, never true for a Factory model. The new `reachesBudgetedHost()` equals it for every other provider; for Factory Droid it is true when `baseUrl` is unset or on Factory's global or EU host, so a custom gateway keeps its own limit. The byte clamp and snapcompact's frame and count budgets use it; leaked-thinking healing keeps `reachesOfficialEndpoint()`.
- Keep-latest, as Droid does: with `request-body-byte-limit` set, the byte clamp evicts older images before the newest user message's or tool result's, so a fresh 3.8 MB screenshot goes through.

The renamed `budgetedHost` parameter keeps its type, so nothing breaks.

## Why

Droid 0.239+ applies this on every Factory-hosted HTTP send and not on BYOK, Prem or the Responses WebSocket; omp sends every Factory route over HTTP.

Limits:
- Only images are bounded; more than about 1 MB of text and tools can still exceed 4.5 MB (Droid behaves the same).
- Eviction shifts the kept set as images arrive, rewriting the prompt cache from the first changed message. Factory already had this churn from the 5-image cap; Droid's 1 MB eviction steps are not ported (#15230). PDFs stay outside omp's clamp.

#15091 and #7549 make budgets configurable; this adds no setting, so either can override it. This addresses #14845 for Factory only.

## Testing

- `provider-image-budget.test.ts`: an over-limit Factory request is trimmed under 4.5 MB (global and EU URLs) and untouched on a gateway; five 1 MB screenshots are trimmed to three; a fresh 3.8 MB image survives while older ones go, and a 4.6 MB one is dropped. All fail on main; keep-latest also fails on this PR's first commit.
- `budgeted-host.test.ts`: the gate across unset, global, EU, lookalike, `http:`, gateway and unparseable URLs, and other providers.
- `snapcompact.test.ts`: Factory's hosted frame budget.
- `bun test` for catalog, ai, snapcompact, coding-agent; `bun run check:ts`; `bun check`.
- Live: a Factory turn on `claude-haiku-4-5-20251001` with a small PNG attached answers correctly.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
