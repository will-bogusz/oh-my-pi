## What

Web reads were spending a tenth of their tokens on Open Graph and Twitter tags and on `(#anchor)` targets nobody can follow, so I strip those from the HTML before the native reader converts it.

Over 200 real pages agents read, the rendered text `read` returns is 708k → 652k tokens (−7.8%; median page −9.3%, one page in ten −37% or more), with the page's visible text unchanged.

| | `main` | this PR |
|---|---|---|
| `<meta>` tags in the front matter | all: `og:*`, `twitter:*`, viewport, theme colour, site verification, CSP nonces, … | description, author, published/modified time (title and canonical URL come from `<title>`/`<link>` as before) |
| Link to an anchor on the same page | `[method](#class-renderingserver-method-environment-set-fog)` | `[method](#)` |
| Code, other links, other readers' output | | unchanged |

## Why

The native html-to-markdown reader writes every `<meta>` in `<head>` as a front-matter line: on the median page that is 11% of its tokens, at the top of the 300-line first page. Sphinx docs, Godot's class reference, PubMed Central and most API references link every heading, table row and citation to an anchor on the same page; on Godot's `RenderingServer` reference those `(#…)` targets are about a fifth of the tokens, and a reader of the rendered page has nowhere to follow them.

Decisions:
- The change edits `<meta>` and `<a>` start tags before conversion, not the markdown after it. A first version rewrote the markdown; review found it could not tell generated front matter from a body that looks like YAML, or link syntax from code spans, blockquoted fences and `#method(int)` targets. Tags have no such ambiguity, and code blocks hold only escaped text.
- A same-page link keeps `[text](#)` and its `title`: brackets keep citations apart from words (`studies[1](#)`, not `studies1`).
- A page whose only content is its `<head>` can drop under the 100-character check once pruned; it is converted whole, so it reaches the same reader it did on `main`.
- Not taken: dropping the front matter (`extract_metadata: false`) leaves head-only pages empty; absolute links (`base_url`) cost +19% tokens.

## Testing

- `bun test test/tools/fetch-markup-tokens.test.ts`, pages served locally: the front matter keeps `title` and `meta-description` and loses `og:`/`twitter:`/viewport/verification lines; a body paragraph shaped like front matter survives; same-page links become `[text](#)` with their title, an image inside one keeps its `src`, and code blocks, blockquoted code, inline code with a backtick and external `#` links are untouched; a head-only page still renders; Jina's output keeps its own front matter. The first two fail with `fetch.ts` from `main`; all `fetch-*` suites pass.
- Corpus: 237 pages from session `read` calls, saved and served locally, read through `main`'s and this branch's `ReadTool` with remote readers off. All 200 native renderings stay native; their visible body text is word-for-word the same, the only words lost are `<meta>` values.
- Haiku 5.5 answered 88 questions about 30 of the pages (written from each page's full text): 87 from `main`'s rendering, 87 from this one.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
