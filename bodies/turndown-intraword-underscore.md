## What

`read` of a Word doc showed `DOCX\_NEEDLE\_1` where the doc says `DOCX_NEEDLE_1`, so an agent copying or grepping that identifier misses it, and I made underscores inside words stay literal.

The HTML-to-Markdown step every converted page and document goes through (`createTurndown`) escaped every `_`. Word and EPUB `read`s, the site-specific web scrapers (Stack Overflow, MDN, GitLab, …) and the browser's readable extraction all use it:

```diff
- First paragraph with DOCX\_NEEDLE\_1 and snake\_case.
+ First paragraph with DOCX_NEEDLE_1 and snake_case.
```

Underscores that could open or close emphasis keep their escape (`\_not emphasis\_`, `\_\_init\_\_`).

**Beyond the Markdown:** the browser's filtered plain-text extraction (`tab.extract("text", { filter })`) stripped every `_` from that Markdown, which on main gave `DOCX\NEEDLE\1`. It now keeps escaped characters as text and drops only `_` runs outside a word, so it reads `DOCX_NEEDLE_1` too.

## Why

CommonMark and GFM never open or close `_` emphasis when the run sits between two letters or digits, so those escapes only corrupt the text. The fix wraps the instance's `escape` in `createTurndown` (omp's layer of fixes over Turndown, next to the heading-period unescape) instead of changing the vendored `TurndownService`, whose golden tests keep upstream Turndown's escaping.

Non-goals: other escapes (`\*`, `\[`, a leading `\#`) are unchanged; they guard real Markdown syntax.

## Testing

- New `test/utils/turndown.test.ts`: intraword underscores stay literal (fails on main), emphasis-capable runs stay escaped, and an escaped literal backslash before `_` keeps both escapes.
- New `browser-readable.test.ts` case: filtered plain text keeps `DOCX_NEEDLE_1`, `my__var` and literal `_this_`, and drops `<em>`'s underscores. With main's `readable.ts` it fails (`DOCXNEEDLE1`).
- Ground-truth harness on goliath (140 `read`/`grep`/`edit` cases through a real `AgentSession`, main `d5cd750` vs this branch): the only change is the Word fixture, from 3 of 5 needles with `\_` escapes and out-of-order content to 5 of 5 and clean. The other 139 cases are unchanged.
- `bun test test/utils/turndown.test.ts test/tools/browser-readable.test.ts test/tools/web-scrapers`: 47 pass. `tsgo --noEmit` for coding-agent, oxlint and oxfmt are clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
