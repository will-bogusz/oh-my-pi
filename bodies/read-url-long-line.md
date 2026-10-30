## What

Reading a minified page with `:raw` gave the agent a truncation notice and nothing else, because the whole first line was over the 50 KB budget, so I made whole-URL reads show the first 50 KB of that line the way file reads already do.

Asked for a page's `viewport` meta tag, agents now answer from their first `:raw` read: 24 → 9 `read` calls for Haiku 5.5 and 25 → 9 for GPT-6.1 Sol over 8 minified pages, same answers.

What the model gets from `read <url>:raw` on a 289 KB page whose line 1 is 57.4 KB:

| `main` | this PR |
|---|---|
| `[Showing line 1 (partial, 0B of 289.1KB) of 48. Read artifact://0 for full output]` and no content | the first 51,200 bytes of line 1 (`<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" …`), then `[Showing line 1 (partial, 50.0KB of 57.4KB) of 48. Read artifact://0 for full output]` |

- `executeReadUrl` (`tools/fetch.ts`): when `truncateHead` reports `firstLineExceedsLimit`, the body is `truncateHeadBytes` of the response (UTF-8 safe), and the truncation result counts that preview against line 1's size, the values the file path in `read.ts` reports.
- New test in `test/tools/fetch-raw-mode.test.ts`.

## Why

`truncateHead` keeps whole lines only and returns an empty body when the first line alone is over budget. File reads and URL line ranges (`:1-5:raw`) show a byte-capped preview for that case; whole-URL reads passed the empty body through, and the notice gave the whole response's size as the line's. Minified HTML puts the whole `<head>`, often the whole document, on line 1, and `:raw` is how agents look up meta tags, so each lookup cost a wasted read plus a retry with a line range.

Non-raw URL reads can't reach this branch: their output starts with a short `URL:` header line.

Related: #16024 fixes the same `truncateHead` contract on the JSON-query path and the URL line-range notice (it shows the preview but reports `0B`); this PR leaves `read-format.ts` to it.

## Testing

Live: 8 pages from a 238-page web corpus whose first line is 57–740 KB, served by a local Bun server; `omp -p --tools read --thinking low`, prompt "What is the `viewport` meta tag value of the web page <url>?", one run per page, model and arm, scored from the transcripts.

| | `main` | this PR |
|---|---|---|
| Haiku 5.5: correct / `read` calls / empty reads | 8/8 · 24 · 8 | 8/8 · 9 · 0 |
| GPT-6.1 Sol: correct / `read` calls / empty reads | 8/8 · 25 · 8 | 8/8 · 9 · 0 |
| Session tokens, median (Haiku · Sol) | 70.1k · 46.5k | 46.9k · 30.9k |

On `main` each of the 16 runs got one empty `:raw` result and needed two or three more reads (the rendered page, a `:raw` line range); with the PR 14 runs answered from the first read and 2 read the rendered page first.

- `shows the head of a first line over the byte budget instead of an empty body` fails on `main` (body length 0, expected 51,200) and passes here.
- `bun test test/tools/fetch-*.test.ts test/tools/read-truncation-metadata.test.ts test/tools/grep-url-selectors.test.ts`: 109 pass. `bun run check` in `packages/coding-agent`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
