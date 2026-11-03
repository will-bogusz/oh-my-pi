## What

I fixed role selectors missing named sections even when the browser's accessibility snapshot showed them as regions.

`role/region[name="billing-worker"]` now scopes `ariaSnapshot()` and `observe()` to that section instead of failing with “matched no element”. Other missing implicit landmark and structural roles use the same shared handler in Chrome and Tern. This does not change observation output or browser guidance.

## Why

Role selectors recognized a small tag list, so a section labelled by its heading had no matching role. The handler now includes Chrome-probed HTML roles, name-dependent sections, and header/footer scoping. Native fieldset and option-group names allow name filters on their new group roles.

I kept the page-world handler rather than switching to CDP `Accessibility.queryAXTree`: Puppeteer's custom query handlers and Tern's page kit serialize the same self-contained synchronous function, and Tern cannot call CDP. A Chromium accessibility-tree oracle checks both missing and extra matches rather than repeating the table in test expectations. Chrome reports even unnamed forms as `form`, so that existing mapping stays; browser changes can require updating the table, with the oracle exposing drift.

Review `queryByRole` first, especially section naming and header/footer ancestry. Tern's serialized kit runs in the Chromium test; native WebKit was not run here, and cmux's separate selector implementation is unchanged.

## Testing

- `bun test --timeout 120000 packages/coding-agent/test/tools/browser-implicit-roles.test.ts packages/coding-agent/test/tools/browser-queries.test.ts`: 32 passed. The new oracle fails with the handler reverted; its expanded ancestor and image cases also fail with the review corrections reverted.
- Live headless browser-tool API: three named sections each contain a `REGION` combobox. Both exact and substring region selectors return the billing section snapshot; scoped observation returns just its one combobox, with value `billing-worker-region`.
- `bun run --filter './packages/coding-agent' check:types`: passed.
- `bun run check:ts`: blocked by existing formatting errors in `interactive-click-focus.test.ts` and `packages/tui/src/tui.ts`, before package type checks.
- No model-driven sample set: selector resolution is deterministic and no prompt text changed; the browser API run exercises the reported failure directly.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated (PR attribution added when opened)
