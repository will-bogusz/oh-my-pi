## What

I made a scoped `waitForText` ignore an element the page does not render, because it resolved on a success message that was still hidden.

`tab.waitForText(text, { selector })` now finds no text in an element that is `display: none` (or `hidden`) or sits inside one, on Chromium, cmux and Tern. On `main`, on the Browser Use shadow-DOM form, `tab.waitForText("The secret is:", { selector: "#success-message" })` resolves in 6 ms on page load, while the banner is still hidden by `.alert { display: none }`. With this change it times out after 3 s, as the unscoped wait already did on `main`.

## Why

A wait that resolves on markup the page has not shown reports a success that did not happen. The unscoped wait reads `document.body.innerText`, which leaves unrendered text out. The scoped one read the element's `innerText`, and for an element that is not rendered, `innerText` returns `textContent`, hidden text and all. A zero-model probe found this; no recorded run used the scoped form.

Shape of the fix: `renderedText` in `queries.ts` is one self-contained page-side function. It returns `""` when the element or a flat-tree ancestor (through slots and shadow hosts) is `display: none`, and the element's `innerText` otherwise. Chromium, cmux and the Tern page kit all run it. Text inside a rendered element is unchanged, `opacity: 0` included. Semantic delta: a scoped wait on `title`, a `<script>` data blob or a closed `<dialog>` matched on `main` and now never does (use `tab.title()` or `evaluate`). Known limit: content slotted into a closed shadow root has no `assignedSlot`, so a hidden slot there is not seen.

## Testing

- `bun test test/tools/browser-queries.test.ts`, "waits only for text the page renders, with or without a selector", on real headless Chromium: scoped waits time out on a `display: none` element, its xpath `text()` node, a child of a `display: none` wrapper, an element slotted into a hidden shadow slot, and an element inside a hidden shadow host; a shown element and its `text()` node resolve; Tern's kit gives the same answers. `browser-cmux-page-text.test.ts` checks cmux the same way. With the source change reverted both cases fail (the hidden waits resolve).
- `browser-tern-tab.test.ts` passes; `bun run check:types` and `oxfmt --check` pass.

## Questions for the maintainer

Other reads give hidden text too. Left alone here; callers may rely on them. Probe on `main`, one element each:

| read | `display: none` / `hidden` / inside one | `visibility: hidden` | inside closed `<details>` | `opacity: 0` |
|---|---|---|---|---|
| `tab.text(selector)` | the text | `""` | `""` | the text |
| `tab.text()`, `extract()` | left out | left out | left out | included |
| `isVisible`, `waitForSelector({ visible })` | false / waits | false / waits | **true** / resolves | true / resolves |

1. `tab.text(selector)` returns a hidden element's text In a Browser Use run, an agent submitted the shadow-DOM form, its unscoped wait for "The secret is:" timed out, and `tab.text("#success-message")` returned the hidden banner's full text as its confirmation. I'd return `renderedText` here too, matching `tab.text()` on the body, and leave `textContent` to `evaluate`.
2. `isVisible` says true for content of a closed `<details>`. I'd make it false (`checkVisibility()` says so).
3. `opacity: 0` counts as visible everywhere, as in Playwright. I'd keep that.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
