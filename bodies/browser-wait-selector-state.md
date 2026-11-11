## What

I made selector waits on Chromium-backed tabs and frames honor `state` and reject misspelled options instead of waiting for the wrong condition.

Waiting for an already-removed element with `state: "hidden"` or `"detached"` went from a 20-second timeout to 0–12 ms, with five runs of each state.

This covers Chromium-backed tabs and their scoped frames, which is OMP's own Chromium and the Chrome relay, where the wait was measured. Tern and cmux are unchanged: Tern still reads only `visible`/`hidden` and cmux only `timeout`, so on those two a `state` or a misspelled option is still ignored and `state: "hidden"` still waits for the element to appear. Existing `visible`/`hidden` forms remain accepted; `detached` requires absence, not just invisibility, except that a `role/` selector never matches a hidden element, so its `detached` wait also ends when the match is hidden.

## Why

The Chromium helper discarded `state`, so disappearance waits instead waited for appearance. Shared validation now names accepted forms and rejects conflicting visibility flags; raw Puppeteer APIs are unchanged.

## Testing

- Real headless Chromium: five repetitions of each state and legacy form; removed hidden/detached selectors time out on main and resolve with this fix. Invalid-key/value cells are rejected rather than accepted.
- Real-worker regressions cover live refs, scoped frames, public detached waits across navigation and delayed-caught frame timeouts. Dropping state hand-through makes the public navigation test fail. Focused suite: 43 pass, one desktop-only skip. Coding-agent type check passes.
- Re-run: `bun test packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts packages/coding-agent/test/tools/browser-tern-tab.test.ts packages/coding-agent/test/tools/browser-cmux-page-text.test.ts`; `bun run --cwd packages/coding-agent check:types`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution
