## What

Agents reading API references and pricing pages were getting trafilatura's or Jina's cut-down copy because tables and code look like menus to the navigation check, so I limited that check to lynx, the one reader that dumps menus.

On the pages that check rejected, the first page `read` returns now answers 77 of 120 questions about the page's content, against 53 on `main`.

| 42 real pages the check rejected (120 questions) | `main` | this PR |
|---|---|---|
| Reader whose output `read` returns | trafilatura 25, Jina 13, native 4 | native 42 |
| Questions answered from the first page shown (300 lines) | 53 | 77 |
| Questions answered from the whole rendering | 55 | 92 |
| Tokens of the first page, all 42 pages | 58.7k | 62.8k |

## Why

`renderHtmlToText` accepts the first reader output that is not `isLowQualityOutput`, which calls a rendering "mostly navigation" when over 70% of its lines are under 40 characters. That rule was written for lynx's whole-page dump. The native reader runs first with navigation already removed, and in its markdown the short lines are table rows, code, list items and headings (the GFM spec, API references, pricing and status pages). So `read` threw it away, ran trafilatura (or Jina, a remote call) and returned the first output that passed, which usually kept less of the page. When nothing passed, `read` kept the native text but noted "Page appears to require JavaScript or is mostly navigation".

Decisions:
- The short-line rule still judges lynx output; the JavaScript-gate phrase check still applies to every reader.
- A short-line rendering still has its linked PDF or DOCX tried, as on `main`, whichever reader rendered it: a landing page around a report looks the same as a menu. It no longer gets the section `llms.txt` substituted or the note; in this machine's sessions `llms.txt` replaced a page once in 12,477 URL reads.
- Not changed: a page whose native body is empty under its `<head>` metadata still counts as content, because the 100-character check includes the metadata. The two pages where a fallback beat native were of that kind; that is a separate fix.

Cost: none on pages the check passed. On the 42 pages, 7% more tokens on the first page; session medians were 0.8 s for a native read against 1.6 s (trafilatura) and 4.1 s (Jina) for the fallbacks this skips.

## Testing

- `bun test test/tools/fetch-navigation-gate.test.ts`: an API-reference page (parameter table, code, list) renders through `renderHtmlToText` as `native` without calling trafilatura or a remote reader, and `read` of it served locally carries no navigation note; both fail with `fetch.ts` from `main`. A short landing page linking a PDF still returns the converted document (passes on `main` too). The other `fetch-*` suites pass unchanged.
- Corpus: 237 pages agents read (from session `read` calls), re-fetched with `loadPage` and rendered with `main`'s native converter; 42 failed the check. Haiku 5.5 wrote up to 3 questions per page from its full text (120 in all), answered them from each output (first page and whole), and a separate judge graded the answers. `main`'s pick is replayed from the same HTML: trafilatura on it, Jina fetched live, no lynx.
- `omp read` live on `main` → branch: `https://github.github.com/gfm/` and a GPU pricing page went `trafilatura` → `native`; `https://status.railway.com/` dropped the false note.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
