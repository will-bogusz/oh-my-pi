## What

I made `tab.hover` wait for a hidden target the way `tab.click` does, because on pages with duplicate responsive markup a hover on the hidden copy failed at once with a Puppeteer message that never said the match was hidden, and agents retried it unchanged.

On Chromium tabs, `tab.hover` and element-handle `hover()` now keep checking until the target has a layout box that Puppeteer can scroll into view. If the action's timeout ends first, they fail with the last reason (such as `display:none`, `off-viewport` or detached) and, for a selector, the match count, as a click does; a handle whose hover timed out is invalidated, as after a click. Once the target qualifies, the move is Puppeteer's own `hover()`, unchanged from `main`.

| Target | `main` | this PR |
|---|---|---|
| hidden first of two `.menu` matches | `Node is either not clickable or not an Element`, at once | waits, then `…never became clickable (last check: display:none; selector matches 2 element(s))` |
| shown 300 ms after the call | the same error, at once | hovered |
| off-canvas `position:fixed` drawer | the same error, at once | waits, then `last check: off-viewport` |
| `opacity:0` or `visibility:hidden` until hovered, `pointer-events:none` icon, covered, moving, 1.4 px wide | hovered | hovered, same pointer events |

A hover onto a covered target still lands on the cover, as on `main`; telling an intended hover target from a cover is left out on purpose. Resolving means the pointer moved, not that a reveal finished. Tern, cmux and first-match selector resolution are unchanged.

## Why

A pricing page in a Browser Use task rendered its menu twice for desktop and mobile. The first copy was hidden, and the agent retried Puppeteer's raw error four times. Clicks already explain that failure.

Hover reuses only the wait, not click's other checks: click's recentring and hold-still gate would scroll a target already in view and stall on one that animates until hovered, and a hit test after the move refused real hover targets under labels, sibling content and shadow hosts.

## Testing

On Linux (headless Chrome, published 18.18.8 native addon), `bun test packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts -t hover` fails on `main` (the raw error on the hidden match) and passes here; it also checks that reveal-on-hover and moving targets are still hovered and that a target already in view is not scrolled. A probe of 16 target kinds through `tab.hover` and tool handles gives the table: 12 match `main` exactly, and the 4 that differ are the hidden, late, hidden-handle and off-canvas rows. Root `bun run check:ts` and the focused `browser-tab-worker-startup`, `browser-interactions`, `browser-background-input` and `browser-relay-tab-isolation` files pass.

No model sample set ran. The change is in when a hover starts and how it fails.

---

- [x] `bun check` passes (root `bun run check:ts` and focused browser tests ran)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
