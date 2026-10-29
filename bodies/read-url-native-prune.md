## What

Web reads were spending a tenth of their tokens on Open Graph and Twitter tags and on `(#anchor)` targets nobody can follow, so I drop those before the native reader converts the page, using a real HTML tokenizer in the natives instead of a hand-written TypeScript one.

Over 200 real pages agents read, the text `read` returns goes from 702k → 646k tokens (−8.0%; median page −9.5%), with the page's visible text unchanged.

| | `main` | this PR |
|---|---|---|
| `<meta>` tags in the front matter | all: `og:*`, `twitter:*`, viewport, theme colour, site verification, … | description, author, published/modified time (title and canonical URL as before) |
| Link with text to an anchor on the same page | `[method](#class-renderingserver-method-environment-set-fog)` | `[method](#)` |
| Empty permalinks, code, other links, other readers' output | | unchanged |

Supersedes #17350.

## Why

The native reader writes every `<meta>` in `<head>` as a front-matter line: on the median page that is 11% of its tokens, at the top of the first page. Sphinx docs, Godot's class reference and most API references link every heading, row and citation to an anchor on the same page, which a reader of the rendering can't follow.

Decisions:
- `htmlToMarkdown` prunes (`metaNames`, `dropAnchorTargets`, `url`) on the page as `lol_html`, Cloudflare's streaming HTML rewriter, tokenizes it: raw-text elements, `<plaintext>`, quoting and character references as HTML reads them, so a tag written in a title, an attribute, a script or a comment stays text. The matched `<meta>` start tags are cut and the matched `href` values replaced at their source positions; every other byte reaches the converter as written. #17350 did this with a TypeScript scanner, and Codex found a new tokenizing corner in each of its six rounds.
- Not taken: an option on html-to-markdown-rs's own DOM. Its front matter and same-page link test are private, and its `visitor` hook changes preprocessing (closed forms are kept), so that needs an upstream change.
- A link keeps its target when it has no text of its own (script and style text aside) or another `<a>` opens inside it, so the converter still leaves out empty permalinks (`<a href="#setup"></a>`) as on `main`. Rewritten to `#`, they printed `[](#)` or `[Permalink for this section](#)` on 11 of 200 pages under #17350.
- Hash routes (`#/guide`, `#!/page`, also with a tab or newline in them) keep their target, and so does every `#…` link on a page with a `<base href>` that leads to another page.
- A page whose only content is its `<head>` can fall under the 100-character check once pruned; it is converted whole, as on `main`.

Maintenance: `lol_html` 3.0 brings `cssparser`, `selectors` and `mime` into the natives build (+0.9 MB on the unstripped Linux addon); `html5ever` and `url` were already in the graph.

## Testing

- `cargo test -p pi-natives --lib html::`: a `<meta>` written in `<title>`, an `alt`, a quoted `content`, a script, a comment, a `<textarea>`, after `</title` plus NBSP, or after `<plaintext>` is left as written; `content=x="` reads as HTML reads it; `&#35;`, `&#99` without `;` and `&sol;` are decoded; only the `href` value changes in `<a href="#x" / title=foo>`; nested `<a>`, script-only and text-less links, hash routes with `&#9;`, and links under a `<base>` leading elsewhere (one in `<template>` or SVG included) keep their target.
- `bun test test/tools/fetch-markup-tokens.test.ts`, pages served locally through `ReadTool`: front matter keeps title, description, author and date; same-page links become `[text](#)` with their title; code, external `#` links, hash routes, `<base>`-moved links and empty permalinks are untouched; a head-only page still renders. It fails with `main`'s `fetch.ts` and with #17350's (the empty-permalink check). All `fetch-*` suites pass, 91/91, and the `htmlToMarkdown` natives tests 12/12.
- Corpus: 238 pages saved from session `read` calls, served locally, read through `main`'s, #17350's and this branch's `ReadTool` with remote readers off. All 200 native renderings stay native. Output is byte-identical to #17350 on 227 pages; on the other 11, every line that differs matches `main`.
- Speed: on the 16 corpus pages over 0.9 MB, the native render takes 0.91× #17350's time and 1.06× `main`'s (geometric mean of per-page medians, 5 interleaved rounds; `main` against itself 1.05×, per page 0.72–1.54×).
- `scripts/rust-check` (clippy, rustfmt) passes on Linux and macOS.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
