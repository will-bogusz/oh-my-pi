## What

I made `tab.hover` check its target the way `tab.click` does, because on pages with duplicate responsive markup a hover failed with a Puppeteer message that never said the match was hidden, and agents retried it unchanged.

On Chromium tabs, `tab.hover(selector)` and `BrowserElement.hover()` now aim the pointer where a click would land. A hidden match waits and then fails with the reason and the match count, as a click does: `tab.hover(".menu") timed out after 8000ms; the element never became clickable (last check: display:none; selector matches 2 element(s))`. A covered target fails at once: `tab.hover("#save") blocked: covered by <div#overlay>`. On `main` both called Puppeteer's `hover()`, so the hidden match threw `Node is either not clickable or not an Element`, and the covered one moved the pointer onto the overlay and reported success.

**Beyond the fix:** a `pointer-events:none` target is now refused, as clicks, Playwright and omp's Tern backend refuse it; on `main` the pointer moved there. An `opacity:0` target is still hovered, since hovering is often what shows it (a row's delete button).

## Why

In a Browser Use benchmark task on a pricing page that renders the same menu twice (desktop and mobile), the agent got the raw Puppeteer error four times in a row: the first match was the hidden desktop copy. A click on the same selector already explains itself.

Shape of the fix:
- `hoverElement` (`interactions.ts`) reuses `actionableClickPoint`, the click's loop of scroll into view, stable box and unobscured point, then moves the pointer there. One flag skips the `opacity:0` rule for hover.
- Resolution is unchanged: `#resolveActionHandle` takes the first match, as for clicks. The timeout hint in `act` is shared, so a hover reports "never became clickable" too.
- Tern and cmux hover are untouched.

Non-goal: looking the element up again when the page replaces it mid-hover.

## Testing

- `bun test test/tools/browser-tab-worker-startup.test.ts -t "hover target"` on a page with a hidden first `.menu`, a covered button and a hover-revealed `opacity:0` button: the hidden match fails with the reason and count, the covered one is refused through a selector and through a handle, and the visible and `opacity:0` targets get their `mouseover`. With the source change reverted, the first assertion gets `Node is either not clickable or not an Element`.
- `browser-interactions`, `browser-background-input` (hover in a background tab that draws no frames) and `browser-relay-tab-isolation` pass; a handle inside an offset iframe gets its `mouseover`, as on `main`.
- Not run: a model sample set. The change only moves which error a failing hover reports, or refuses one that hovered the wrong element, so a session reaches it only on such a page.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
