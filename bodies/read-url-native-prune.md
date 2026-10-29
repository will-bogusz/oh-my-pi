## What

I cut the native reader's front matter down to the tags a reader uses and list the rest by name, because Open Graph, Twitter Card, viewport and verification tags were costing web reads tokens on nearly every page.

Over 200 real pages agents read, the text `read` returns goes from 702k → 662k tokens (−5.7%; median page −5.6%), with the page body byte for byte as on `main`.

One page, values cut:

```diff
 ---
-meta-color-scheme: only light
 meta-description: Flagship performance · Full modality · …
-meta-google-site-verification: fApb5wSvB0DyjGLkmMp1PESdGrmfOtPfyhdYUboSJzE
-meta-og:description: Flagship performance · Full modality · …
-meta-og:image: https://mimo.mi.com/og-image.jpg
-meta-og:image:height: "630"
-meta-og:image:width: "1200"
-meta-og:title: "Xiaomi MiMo-V2.6 Series: 3 New Models Officially Released"
-meta-twitter:card: summary_large_image
-meta-twitter:description: Flagship performance · Full modality · …
-meta-twitter:image: https://mimo.mi.com/og-image.jpg
-meta-twitter:title: "Xiaomi MiMo-V2.6 Series: 3 New Models Officially Released"
-meta-viewport: width=device-width, initial-scale=1.0, maximum-scale=1.0
 title: Xiaomi MiMo Home
+meta_omitted: "color-scheme, google-site-verification, og:description, og:image, og:image:height, og:image:width, og:title, twitter:card, twitter:description, twitter:image, twitter:title, viewport; read the URL with :raw for their values"
 ---
```

| | `main` | this PR |
|---|---|---|
| Title, canonical URL, `description`, `author`, published/modified time | in the front matter | same |
| Every other `<meta>` tag | one line each, with its value | named in one `meta_omitted` line (25 names, then `+N more`); `:raw` returns the values |
| Page body, links, reader choice, other readers' output | | unchanged |

## Why

Decisions:
- `pruneFrontMatter` in `fetch.ts` drops lines of the front matter html-to-markdown-rs writes: it escapes each key and value onto one `key: value` line, so filtering by key is exact. No Rust change.
- Names, not silence: a task about the page's own metadata (SEO, link previews, mobile viewport) must see that a tag exists. They cost 12.6k of the ~52.9k tokens dropped; 25 names cover every omitted tag on 178 of 192 pages.
- Only the copy `read` returns is pruned, after the reader and fallback checks judged the whole rendering. A head-only page keeps its front matter.
- Names match as written, in any case (`auth&#111;r` is listed, not kept).
- An earlier head also rewrote same-page links via a new HTML rewriter in the natives; that part is out.

Maintenance: if the converter's front-matter format changes, the block is left as written and `fetch-markup-tokens.test.ts` fails.

## Testing

- `fetch-markup-tokens.test.ts` (9 tests, through `ReadTool`): escaped values, odd names (entity, tab, `, `, empty), the cap, `:raw`, a page that pruned would look JavaScript-walled, head-only, a body opening with `---`. 4 fail on `main`'s `fetch.ts`; reverting each review fix fails its test.
- `bun test test/tools/fetch-*.test.ts test/tools/read*.test.ts`: 284 pass, 5 skipped.
- Corpus: 238 pages from session `read` calls, read through `main` and this branch. Same reader on all 238; on the 200 native pages the rendering after the front matter is byte-identical and the kept lines equal the earlier head's. 13 pages grow 1–11 tokens.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
