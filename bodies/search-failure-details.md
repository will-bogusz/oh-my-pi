## What

I am wondering if there's a way that we can figure out which searches it's doing that end up refusing things.

When `web_search` falls back, the model's text already says so (`Note: answered by DuckDuckGo after SearXNG failed (…)`), but the saved tool result keeps only the winning response, so a session file cannot say which provider failed or refused without parsing that note. This PR adds the list to the result's details:

| `web_search` outcome | `details` on `main` | `details` with this PR |
|---|---|---|
| First provider answers | `response` | `response` (no `failures` key) |
| A fails, B answers | `response` | `response`, `failures: [A]` |
| Every provider fails | `response`, `error` | `response`, `error`, `failures: [A, B, …]` |

Each entry is `{ provider, label, reason, status? }`. For example, from a real run with SearXNG unreachable:

```json
"failures": [{ "provider": "searxng", "label": "SearXNG", "reason": "ECONNREFUSED: Unable to connect. Is the computer able to access the url?" }]
```

A hosted search model that answers from its weights with no sources already counts as a failure (`returned no sources …`, status 204). A refusal looks like that, so refusals land under `status: 204`, along with other answers that came back without sources.

Non-goals: the TUI, the `omp q` output and the model's text stay the same, and no provider's behaviour changes.

## Why

Sessions store tool-result `details` as structured data, so `jq` or SQL over them can count failures per provider without parsing the note's wording.

- `reason` is the same flattened, 240-character-capped string the note quotes. One helper, `failureReason`, now serves both the note and `failureDetails`, so they cannot drift apart.
- `status` comes from `SearchProviderError.status` and is left out when the error has none (network errors, plain `Error`s).
- `provider` is the search provider's id, or the catalog model id when the provider never loaded. This matches what `fallbackNotes` and `formatSearchProviderFailures` already name.

Maintenance cost: none outside `executeSearch`. A new return path has to pass `failureDetails(failures)`, as both current paths do.

Review first: `failureReason` / `failureDetails` in `web/search/index.ts`, then `SearchFailureDetail` in `web/search/types.ts`. `docs/tools/web_search.md` documents the field under Outputs.

## Testing

- `test/web/search/abort-and-timeout.test.ts`, through `runSearchQuery` with the providers mocked by `spyOn`. In the existing fallback case, where exa throws a 500 and brave answers, `failures` now holds exa with status 500. A new case has exa (204) and brave (a plain `Error`) both fail: both are listed, and brave has no `status`. The case where the first provider answers now asserts that `failures` is absent. 17/17 pass. Negative control: with the `index.ts` change reverted, both `failures` assertions fail.
- Live: `runSearchQuery` with the `web` role set to `web/searxng` (`SEARXNG_ENDPOINT=http://127.0.0.1:9`) and fallbacks `web/duckduckgo`, `web/brave`. DuckDuckGo answered with 10 sources, and `details.failures` held the SearXNG entry shown above.
- `bun run check:ts` at the root: clean.

```sh
bun test packages/coding-agent/test/web/search/abort-and-timeout.test.ts
```

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
