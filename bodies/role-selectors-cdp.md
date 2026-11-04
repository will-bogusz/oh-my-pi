## What

I made `role/` selectors in Chrome tabs ask Chrome for each element's role and accessible name, so a name `observe()` shows always selects its element.

#17895's review kept finding names that `observe()` reported but `role/…[name="…" exact]` missed: text from CSS `::before`, a field with two labels, a `<br>` between words, a `<summary>`, a row-header `<th>`, a button in an open shadow root. Each needed another hand-written rule. Now Chrome answers. Tern (WKWebView) has no accessibility tree, so it keeps the rules, as one implementation that both its `role/` engine and its `observe()` call.

## Why

Chrome is asked with `Accessibility.getPartialAXTree` for each candidate element. `queryAXTree` waits for a rendering update, which a background tab (often the relay's agent tab) never gets: it gave no answer within 5 s. `getFullAXTree` costs 70-300 ms on a large page even for one heading. Candidates are the elements whose tag can give the role, elements whose `role` attribute names it, and custom elements.

Visible changes on Chrome: Chrome's own roles work (`role/DescriptionList`); hidden, `aria-hidden` and browser-internal controls no longer match; layout tables still match `role/table`; `::-p-role(…)` is refused. Tern's `observe({ includeAll: true })` lists text as `StaticText` entries, as Chrome's does.

Per call, median of 20 calls; 3.8k-element Wikipedia page unless noted; before = #17895's head:

| Call | headless | relay | relay, background tab |
|---|---|---|---|
| `$ role/heading[name="References" exact]` | 1.1 → 3.0 ms | 1.2 → 5.8 ms | 6.6 → 13 ms |
| `$$ role/navigation` | 1.5 → 1.6 ms | 2.3 → 3.0 ms | 7.8 → 6.0 ms |
| `$ role/button[name="pay"]` (small form) | 0.3 → 1.1 ms | 0.3 → 2.6 ms | 0.6 → 4.3 ms |
| `$$ role/link` (~940 matches) | 7.3 → 27 ms | 14 → 61 ms | 41 → 160 ms |
| `$ role/link[name="privacy"]` (match near the end) | 2.9 → 41 ms | 2.8 → 93 ms | 23 → 214 ms |

The worst case is a substring filter on a common role on a long page, since every earlier candidate is asked about.

Review `queryRoleInAXTree` and `waitForRole` in `query-handlers.ts` first (matches return in Puppeteer's isolated world), then `roleRules()`.

## Testing

- `bun test test/tools/browser`: 776 pass, 0 fail. `bun run check:types` passes.
- On #17895's head, 13 new tests fail, including each Codex case above. A test compares every role Chrome's full tree reports (82 tags, 22 input types, 7 contexts incl. SVG, MathML, shadow roots) with what `role/` returns.
- An independent review's four defects each have a test that fails on the reviewed commit: waits across navigation, Tern date inputs, slotted link text, and Tern `observe()` time (27.5 ms on 2.4k elements; now 7.1 ms, before 6.2 ms).
- Relay numbers come from an isolated relay with its own Chrome for Testing.
- No model sample set: selector resolution is deterministic and no prompt changed.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated (PR attribution added when opened)
