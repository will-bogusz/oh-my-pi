## What

I added Factory as a web search engine, since a Factory login already includes web search and omp couldn't use it without a separate search key.

`web/factory` is a new engine in the `web` role. Anyone signed in with `/login factory-droid` can select it and search through Factory with no Exa, Brave or Perplexity key.

| | Before | With this PR |
|---|---|---|
| Factory-only user, `web_search` | Only the keyless scrapers (DuckDuckGo, Google, …) | Can select `web/factory` |
| Factory org with web search turned off | n/a | `web/factory` refuses before the query is sent: "Factory web search is disabled by your organization's settings." |
| Default `web` chain | unchanged | unchanged: `web/factory` is opt-in |

> **Factory context.** Factory hosts one search route for its CLI and picks the vendor behind it (You.com today; Parallel and Exa shapes are also possible). An org admin can turn it off with the managed setting `webSearchDisabled`, which Factory enforces server-side too.

Reading order: `providers/factory.ts`, then the registrations in `provider.ts` (a lazy loader like its siblings, the registry's first-use pattern), `web-search-types.ts`, `web.kdl`, and `sessionModel` on `SearchParams`.

## Why

Decisions:
- **Opt-in.** Adding it to the default chain would change where every Factory user's searches go. A maintainer who wants that can list `web/factory` ahead of the keyless scrapers in `behavior.kdl`'s `web` role defaults.
- **Org policy first.** omp reads `webSearchDisabled` through the managed-settings helper discovery now shares, cached five minutes per org, so a policy change either way takes effect within five minutes. An unreadable policy allows (cached one minute), matching Factory's CLI when its policy load degrades; a server 403 re-reads it so a fresh disable gets the same refusal.
- **A refusal is not an auth failure.** It carries no HTTP status, so the login is not rotated or blocked and the user sees the org message. It also does not fall through to another stored Factory login.
- **Same request as Factory's CLI for a plain query** (login bearer, org, region, `x-session-id`, `x-client-model` when the session runs a Factory model), sent as `{query, numResults}`; the CLI's optional full-text, structured-data and multi-query forms are unused. 401s refresh or rotate through `withOAuthAccess`.

Maintenance: a Factory response-shape change shows up as empty results; `parseFactorySearchResults` is the one place to fix.

## Testing

- `test/tools/web-search-factory.test.ts`, 15 mocked-Factory tests: request shape, all three response shapes, the org refusal (no query sent, no rotation or credential block), policy caching and fail-open, 401 refresh, bounded error bodies. `default-chain.test.ts`: the automatic chain never tries `web/factory`; `engine-catalog.test.ts`: every engine has a KDL seed.
- Negative controls: giving the refusal a 403 status, removing either policy cache, skipping the 403 re-read, reading the error body unbounded, or sending any session model as `x-client-model` each fails its test.
- Live with a real Factory login: `omp search --model web/factory --limit 3 "bun javascript runtime"` returned 3 sources, shown as `Provider: Factory (OAuth)`.
- `bun run check:ts` passes; `packages/catalog` 1224 pass; coding-agent web search tests 437 pass.
- Not run: a real org with `webSearchDisabled: true` (mocked only).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

