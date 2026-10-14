## What

I made the text-click hit test also probe a match's edges, so `tab.click("text/…")` clicks the first match the browser shows even when a scroll container shows only a thin strip of it.

Since #15496, a text-click candidate counts as on screen only when the browser's hit test at one of nine points inside its box lands on it (15%, 50% and 85% across and down). A duplicate scrolled so that only its edge peeks out of a scroll container, say 8 of 120 px, misses all nine, so the click went to a later duplicate instead. The old `isIntersectingViewport()` path took any visible sliver, and the click then scrolls the match into view. This adds probes half a pixel inside each edge: wherever a scroll container cuts a box, the part left showing touches one of the box's edges.

| | `main` | this PR |
|---|---|---|
| Earlier `Pick` showing 8 px at a panel's edge, later `Pick` fully visible | clicks the later one | scrolls the earlier one into view and clicks it |

## Why

Codex raised this on the merged head of #15496 ([thread](https://github.com/can1357/oh-my-pi/pull/15496#discussion_r4272299356)); it was still unanswered at merge. The browser still decides what is shown: extra probe points can only find a hit the nine missed, never invent one.

Decision: probe the box's edges rather than intersect it with its scroll containers' clip boxes. That intersection is the hand-written clip model #15496 replaced with the hit test, and the edges cover every case where a container cuts off one side of the box. Not covered: a match wider than its container on both sides at once, where the visible window sits strictly inside the box; that needs the clip model back.

Cost: the probes still stop at the first hit; a match that is not shown now costs 25 `elementFromPoint` calls per on-screen fragment instead of 9.

## Testing

- New `clicks the first text match when a scroll container shows only a strip of it` in `test/tools/browser-interactions.test.ts` (headless Chromium): covers 8 px and 1 px strips; fails on `main` with `["later"]` for both, passes with the fix.
- `bun test test/tools/browser-interactions.test.ts`: 20 pass.
- `bun run check:types`, `oxlint`, `oxfmt --check` on the touched files.
- Not run: full `bun check`; its Rust half covers nothing this PR touches.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
