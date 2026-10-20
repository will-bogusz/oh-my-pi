## What

I kept seeing agents give up on SEC filings and news articles with a 403 that a different user agent loads fine, so I made the retry depend on the status code instead of guessing from the error page's wording.

`read` on a web page now retries a 403, 429, 503 or 999 with its next user agent whatever the error page says, instead of only when the page mentions Cloudflare or a captcha. Of 978 URLs whose `read` failed in agent sessions, re-fetched now from one host: 103 → 174 load.

| Refusal on the first user agent (curl) | URLs that load with this PR and fail on `main` | Examples |
|---|---|---|
| 403 with a plain "403 Forbidden" or site page | 48 | SEC EDGAR filings (`:raw`), Ars Technica, AP News, Medium, ftc.gov |
| 429 keyed on the user agent | 26 | Yahoo Finance, VentureBeat |
| 999 | 8 | LinkedIn |
| 503 | 4 | Amazon help pages, Chromium Gitiles |

## Why

`loadPage` tries `curl/8.0`, then a TextBot agent, then a Chrome agent, but moved on only when a 403/503 body contained one of six words ("cloudflare", "captcha", "blocked", …). A bare nginx 403 or SEC's "Undeclared Automated Tool" page has none of them, so the read stopped at curl's refusal although the next agent gets the page: on `main`, `read https://arstechnica.com/gaming/2025/10/valve-upends-the-cs2-item-marketplace-with-new-trade-up-update/` returns `Failed to fetch URL (HTTP 403)`, and `curl -A 'Mozilla/5.0 (compatible; TextBot/1.0)'` gets the 150 KB article. On this machine those URLs account for 95 failed reads in 19 sessions since July.

Decisions:
- A 429 now tries the other user agents before waiting out `Retry-After` (≤10 s) on the last one; in a first probe 25 rate-limited URLs answered TextBot or Chrome at once. A real rate limit still gets its one bounded wait.
- A caller that sets its own `User-Agent` (SEC EDGAR, PubMed, crates.io, MusicBrainz, Repology, Discogs handlers) has nothing to rotate, so its refusal is final instead of being sent three times; transport errors still retry it as before.
- 404 stays final: 4 of 504 failed 404 URLs loaded with another agent, not worth two extra requests on every genuine 404.

Cost: on URLs that fail either way, median 99 ms → 103 ms (n=789).

## Testing

- `bun test test/tools/fetch-user-agent-retry.test.ts` (local servers): a bare-403 page and a 429 with `Retry-After: 10` refused only to curl are read from the next agent; a caller's own agent refused with "Access denied by bot detection" is sent once; a caller's agent whose first request times out is retried. With `types.ts` from `main`, the first three fail (the 429 one after the 10 s wait) and the fourth passes.
- Live A/B from one host over the 978 URLs, `main`'s and this branch's `loadPage` per URL in alternating order: 103 vs 174 load. 15 URLs loaded only on `main` in that run, all Cloudflare challenges; a 3× retest of them loaded 10/45 on `main` and 12/45 on the branch, so they are Cloudflare's variance, not the change.
- `omp read` live on `main` and the branch: Ars Technica 403 → `native`, SEC filing `:raw` 403 → `raw`, Yahoo Finance quote 429 → `native`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
