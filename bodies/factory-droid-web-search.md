## What

I added Factory as a web search engine, since a Factory login already includes web search and omp couldn't use it without a separate search key.

`web/factory` is a new engine in the `web` role. Anyone signed in with `omp login factory-droid` can select it and search through Factory with no Exa, Brave or Perplexity key.

| | Before | With this PR |
|---|---|---|
| Factory-only user, `web_search` | Only the keyless scrapers (DuckDuckGo, Google, …) | Can select `web/factory` |
| Factory org with web search turned off | n/a | `web/factory` refuses before the query is sent: "Factory web search is disabled by your organization's settings." |
| Default `web` chain | unchanged | unchanged: `web/factory` is opt-in |

> **Factory context.** Factory hosts one search route for its CLI and picks the vendor behind it (You.com today; Parallel and Exa shapes are also possible). An org admin can turn it off with the managed setting `webSearchDisabled`, which Factory enforces server-side too.

Reading order: `providers/factory.ts`; `fetchFactoryDroidManagedSettings` in `pi-catalog/wire/factory-droid` (now shared with discovery); `readBodyCapped`, moved from coding-agent to `pi-utils/response-body`; registrations in `provider.ts` (a lazy loader like its siblings), `web-search-types.ts`, `web.kdl`; `sessionModel` on `SearchParams`.

## Why

Decisions:
- **Opt-in.** Adding it to the default chain would change where every Factory user's searches go. A maintainer who wants that can list `web/factory` ahead of the keyless scrapers in `behavior.kdl`'s `web` role defaults.
- **Org policy first.** omp reads `webSearchDisabled` through one managed-settings helper, cached five minutes per org, so a change either way lands within five minutes. An unreadable, failed or oversized (>1 MiB) policy allows, cached one minute, matching Factory's CLI when its policy load degrades.
- **A refusal is not an auth failure.** Neither the org refusal nor any 403 from the search route carries an HTTP status, so the login is never rotated or blocked; a 403 re-reads the policy and names the org setting when it confirms it. A refusal does not fall through to another Factory login. A rejected login (401) refreshes or rotates through `withOAuthAccess`, then tells the user to run `omp login factory-droid`.
- **Same request as Factory's CLI for a plain query** (login bearer, org, region, `x-session-id`, `x-client-model` only when the session runs a `factory-droid` model), sent as `{query, numResults}`; the CLI's optional full-text, structured-data and multi-query forms are unused. Bodies are capped: 2 MiB for results, 4 KiB for error text.

Maintenance: a Factory response-shape change shows up as empty results; `parseFactorySearchResults` is the one place to fix.

## Testing

- `test/tools/web-search-factory.test.ts`, 16 mocked-Factory tests: request shape, response shapes, org refusal and search-route 403s (no rotation or credential block), policy caching and fail-open, 401 refresh and re-login text, body caps. `default-chain.test.ts`: the automatic chain never tries `web/factory`; `engine-catalog.test.ts`: every engine has a KDL seed. Catalog and utils tests cover the shared helper and capped reader.
- Negative controls: a statusful refusal or 403, removing a policy cache, uncapped bodies, or sending any session model as `x-client-model` each fails its test.
- Live with a real Factory login: `omp search --model web/factory --limit 3 "bun javascript runtime"` returned 3 sources, shown as `Provider: Factory (OAuth)`.
- `bun run check:ts` passes; catalog 1227 pass; utils 896 pass; coding-agent web tests 468 pass.
- Not run: a real org with search disabled (mocked).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


