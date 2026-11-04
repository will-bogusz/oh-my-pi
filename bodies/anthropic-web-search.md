## What

I want to see if our use of their web provider is up to date and using appropriate practices to ensure its getting best performance possible.

On 14 queries run twice on each of Claude Haiku 5.5 and Opus 5.5, failed searches went from 14 of 56 to 0 of 56. Every failure on `main` read `Anthropic returned no sources; … may not support hosted web search`, though both models support it.

| Query | `main` | This PR |
|---|---|---|
| `site:`-scoped lookup, e.g. `site:github.com/org/repo/blob/main/src/x.c "fn"` | Claude receives only `"fn"`, answers about something else without searching: "no sources" | Claude receives the whole query and searches the path itself; `allowed_domains` still carries the host |
| A question Claude believes it knows | Answered from memory without searching (5 of 6 Haiku runs on one query): "no sources" | A system line tells it to always search: 0 of 6 |
| CVE or device-security research on Opus 5.5 | Safety-classifier refusal shown as "no sources" | Anthropic retries it on another Claude model; a refusal that stands is reported as one |
| A search that errors (`too_many_requests`, …) | `{} is not iterable` | `Anthropic web search failed: too_many_requests.` |

> **Anthropic context.** `web_search` runs server-side: the model decides whether and what to search and never sees the tool's domain filters. Opus 5 and 5.5, Sonnet 5.5 and Fable return HTTP 200 with `stop_reason: "refusal"` when their classifier declines; [`fallbacks: "default"`](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback) has the API rerun the request on the model Anthropic recommends for that refusal category.

Non-goals: `pause_turn` continuation, the `web_fetch` tool, mapping the role's thinking level to effort.

## Why

`planQuery` moved `site:` out of the message into `allowed_domains`, which suits a keyword engine; here the message is a prompt, so a query whose subject sat in the `site:` value lost it. Anthropic's [web search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) say Claude skips search for questions it treats as stable knowledge and the system prompt steers that. Forcing the tool is out: Opus 5.5 rejects `tool_choice` `tool`/`any` with a 400.

- Fallback goes on every eligible search, not behind `providers.anthropic.serverSideFallback`: that setting opts Fable and Mythos chat turns into a fixed chain, while a search is one stateless request whose result names the model that served it. Eligible is the official API plus a model with catalog `fallback-credit-targets`; Haiku 5.5 has no server-side fallback and is unchanged.
- A refusal after the search ran keeps its sources and replaces the partial answer (the docs say to discard it) with the refusal.
- Not adopted: `web_search_20260318` (dynamic filtering). Over an OAuth login its code-execution calls all returned `too_many_requests`, and their nested results need their own parser.

Maintenance: the beta is one constant; eligibility is a catalog (KDL) read.

## Testing

Live, OAuth login, `runSearchQuery` with an explicit model, raw API responses captured: 14 queries (`site:`-scoped lookups, CVE and device-security questions, trivia, 5 controls) × 2 models × 2 runs. `main` failed 14 (7 `site:`, 1 from memory, 6 Opus refusals), the branch none; controls passed on both. On two refused queries the fallback model (claude-opus-4-8) also refused mid-answer and returned sources under the refusal.

`bun test packages/coding-agent/test/web/search/anthropic.test.ts`: 15 pass; 2 changed, 4 added, and those 6 fail with the source changes reverted. The always-search line has only the live evidence; it reaches Anthropic requests alone.

Review first: `serverSideFallback` in `callSearch` and the refusal branch of `parseResponse`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
