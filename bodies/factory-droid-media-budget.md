## What

I made Factory Droid requests keep inline images under 3.5 MB, the Droid CLI's budget under Factory's 4.5 MB request limit, while still sending the newest message's and newest tool result's images when they fit what the request leaves of that limit.

omp already capped Factory at 5 images (the default count budget), but had no byte budget, and five large screenshots can exceed 4.5 MB. `[INFERENCE]` That likely explains the 413s seen on screenshot-heavy Factory sessions; our transcript sizes are an upper bound, not wire captures.

- `factory-droid.kdl`: `inline-image-byte-budget 3500000` (the axis Anthropic and Codex use), a new `request-body-byte-limit 4500000`, `endpoint-hosts` for Factory's global and EU hosts, and a new `catalog-endpoint-budgets #true`.
- Gate: host budgets applied only under `reachesOfficialEndpoint()`, never true for a Factory model. The new `reachesBudgetedHost()` equals it unless the rules set `catalog-endpoint-budgets`; then it is true when `baseUrl` is unset or `isCatalogEndpointUrl()` matches, so a custom gateway keeps its own limit. The byte clamp and snapcompact's frame and count budgets use it.
- Keep-latest, as Droid does: with `request-body-byte-limit` set, the clamp protects the newest user message's images, then the newest tool result's, newest first, each only while the kept images fit 4.5 MB less the request's other bytes (UTF-8 text, tools, system prompt; not UI-only `details` or another provider's native payload) and a 64 KB envelope for what is added after the clamp. Older images are evicted first.

The renamed `budgetedHost` parameter keeps its type, so nothing breaks.

## Why

Droid 0.239+ applies this on every Factory-hosted HTTP send and not on BYOK, Prem or the Responses WebSocket; omp sends every Factory route over HTTP.

Limits:
- Only images are bounded. A request already under 3.5 MB of images with more than about 1 MB of text still exceeds 4.5 MB; a whole-body cap would be a design change (Droid leaves text unbounded too).
- Eviction shifts the kept set as images arrive, rewriting the prompt cache. Factory already had this from the 5-image cap; Droid's 1 MB eviction steps are not ported (#15230). PDFs stay outside omp's clamp.

#15091 and #7549 make budgets configurable; this adds no setting, so either can override it. This addresses #14845 for Factory only.

## Testing

- `provider-image-budget.test.ts`: an over-limit Factory request is trimmed under 4.5 MB and untouched on a gateway; five 1 MB screenshots go to three; keep-latest and each reserve rule have a case that fails without it.
- `budgeted-host.test.ts`: the gate across unset, global, EU, lookalike, `http:`, gateway and unparseable URLs, and other providers.
- `snapcompact.test.ts`: Factory's hosted frame budget.
- `bun test` for catalog, ai, snapcompact, coding-agent; `bun run check:ts`; `bun check`.
- Live: a Factory turn on `claude-haiku-4-5-20251001` with a small PNG attached answers correctly.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
