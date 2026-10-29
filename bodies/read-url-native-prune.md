## What

Web reads were spending a tenth of their tokens on Open Graph and Twitter tags and on `(#anchor)` targets nobody can follow, so I drop those before the native reader converts the page, using a real HTML tokenizer in the natives instead of a hand-written TypeScript one.

Over 200 real pages agents read, the text `read` returns goes from 702k → 646k tokens (−8.0%; median page −9.5%), with the page's visible text unchanged.

| | `main` | this PR |
|---|---|---|
| `<meta>` tags in the front matter | all: `og:*`, `twitter:*`, viewport, theme colour, site verification, … | description, author, published/modified time (title and canonical URL as before) |
| Link with text to an anchor on the same page | `[method](#class-renderingserver-method-environment-set-fog)` | `[method](#)` |
| Empty permalinks, hash routes, code, other links, other readers' output | | unchanged |

Supersedes #17350.

## Why

The native reader writes every `<meta>` in `<head>` as a front-matter line: on the median page that is 11% of its tokens. Sphinx docs, Godot's class reference and most API references link every heading and row to an anchor on the same page, which a reader of the rendering can't follow.

Decisions:
- `htmlToMarkdown` gains `metaNames` and `dropAnchorTargets`, applied as `lol_html` (Cloudflare's streaming HTML rewriter) tokenizes the page, so a tag written in a title, attribute, script or comment stays text. Only the matched `<meta>` tags and `href` values change; every other byte reaches the converter as written. #17350 did this with a TypeScript scanner, and Codex found a new tokenizing corner in each of six rounds.
- Not taken: an option on html-to-markdown-rs's own DOM. Its front matter and same-page link test are private, so that needs an upstream change.
- Links without text of their own keep their target, so empty permalinks stay left out as on `main` (#17350 printed `[](#)` for them on 11 of 200 pages). So does every link on a page with a `<base href>`: none of the 7 corpus pages with one has a same-page link.

Maintenance: `lol_html` 3.0 adds `cssparser`, `selectors` and `mime` to the natives build (+0.9 MB unstripped).

## Testing

- `cargo test -p pi-natives --lib html::` covers the tokenizer corners Codex raised on #17350 (raw-text elements, `<plaintext>`, quotes, `&#99` without `;`, `=` in unquoted values) plus nested, text-less and hash-route links.
- `fetch-markup-tokens.test.ts` reads local pages through `ReadTool`; it fails with `main`'s `fetch.ts` and with #17350's. All `fetch-*` suites pass (91), and the natives `htmlToMarkdown` tests (12).
- Corpus: 238 pages from session `read` calls, read through `main`, #17350 and this branch. Output equals #17350's on 227 pages; on the other 11 every differing line matches `main`. Haiku 5.5 answered 87 of 88 page questions from both `main`'s and #17350's text.
- Speed on the 16 pages over 0.9 MB: 0.91× #17350's render time, 1.06× `main`'s (`main` against itself: 1.05×).
- `scripts/rust-check` passes on Linux and macOS.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
