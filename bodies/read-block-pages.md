## What

Reading a Reddit thread with omp gave me Reddit's "you've been blocked" page as if it were the thread, so I made `read` recognize bot-challenge pages and say the read was blocked instead of passing them off as content.

On `main`, `read https://www.reddit.com/r/LocalLLaMA/comments/1j9qhvi/` returned `Method: jina` with "You've been blocked by network security… log in… or use your developer token" as the post and no note in 3 of 3 runs; with this PR all 3 end `Method: blocked` with `Blocked by bot protection (JavaScript challenge, HTTP 200)`.

| The fetch got | `main` | this PR |
|---|---|---|
| A 200 challenge page (Reddit's `js_challenge` form, or Cloudflare's `cf-mitigated: challenge`) | rendered through every fallback; Jina's copy of the block page came back as the page | only the remote readers (Parallel, Firecrawl, Jina) are tried; unless one returns more than a JavaScript gate, `Method: blocked` with the protection and status in the note, empty content |
| A 401/403/429 challenge or block page (Cloudflare, DataDome, PerimeterX, "blocked by network security") | `failed`, `HTTP 403` | `failed`, plus `Blocked by bot protection (<vendor>)` |
| A Jina rendering headed `Warning: Target URL returned error`, or a Firecrawl scrape with `metadata.statusCode` ≥ 400 | accepted as the page | rejected like an empty rendering |

Non-goals: no browser fallback, TLS impersonation or challenge solving; `:raw` returns the body as fetched, as before.

Reading order: `botWallOf` in `web/scrapers/types.ts` → the `response.blockedBy` branch of `renderUrl` and the `providers` argument of `renderHtmlToText` in `tools/fetch.ts` → `JINA_TARGET_FAILED_RE` → `scrapeWithFirecrawl`.

## Why

Reddit closed its unauthenticated `.json` endpoints in May ([announcement](https://www.reddit.com/r/modnews/comments/1tq9vxo/)), so the Reddit handler's `.json` fetch now gets 403 and Reddit URLs take the generic path. There the post answers 200 with a JavaScript challenge, nothing renders it, and Jina, which Reddit also blocks, returns the block text, which the agent quotes as the thread. User agent and TLS fingerprint make no difference (seven user agents, curl_cffi's Chrome, Safari and Firefox fingerprints).

Decisions:
- A 2xx page is a wall only from Cloudflare's header or a live `<input name="js_challenge">`, since an article can quote any marker; vendor body markers count only on an error status.
- On a 2xx wall the alternates, content negotiation, trafilatura, lynx, `llms.txt` and raw-HTML fallbacks are skipped: each fetches from this host and meets the same wall, or returns the challenge page.
- Walled error statuses keep `main`'s `failed` and reach no remote reader; only the note is new.
- Jina's "This page maybe requiring CAPTCHA" warning is not used: Jina adds it to any short rendering whose HTML mentions "captcha".

Maintenance: if a vendor renames a marker, that wall reads as on `main`; the fix is one line.

## Testing

- Regression tests in `fetch-http-status.test.ts` and `fetch-jina-stall.test.ts`; the challenge rows, the 403 case and the Firecrawl case fail with the source change reverted.
- `bun test test/tools/fetch-*.test.ts test/web-scrapers test/tools/web-search-firecrawl.test.ts`: 126 pass; `bun run check:types` clean.
- Live through `ReadTool`: Reddit post `blocked` (`main`: Jina block text, 3/3); Reddit `.json`, NYT, Bloomberg, Glassdoor `failed` naming network security, DataDome, PerimeterX, Cloudflare; OpenAI, Medium, Zillow, FT, LinkedIn unchanged.

<details><summary>What each test covers</summary>

A 200 Reddit challenge whose remote reader returns the post (`jina`, note names the wall), its own block page, or a JavaScript gate (both `blocked`); `:raw` returns the challenge body and calls no reader; a 403 Cloudflare challenge stays `failed`, names Cloudflare and calls no reader; an article whose `<pre>` quotes `_cf_chl_opt`, `px-captcha` and an escaped challenge form reads `native`; a Firecrawl scrape with `metadata.statusCode: 403` falls back to `native`.

</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
