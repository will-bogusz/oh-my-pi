## What

I made selector waits honor `state` and reject misspelled options instead of silently waiting for the wrong condition.

Waiting for an already-removed element with `state: "hidden"` or `"detached"` went from a 20-second timeout to 0–5 ms, with five runs of each state.

The four states share option validation across Chromium/relay tabs, scoped frames, Tern and cmux. Existing `visible`/`hidden` forms remain accepted; `detached` requires absence, not just invisibility. Chromium's raw Puppeteer page and ElementHandle methods remain native APIs.

## Why

The helper discarded `state`, so a disappearance wait instead waited for an element to appear. Invalid keys and values now name the accepted forms before any wait starts, following the existing ToolError validation convention rather than silently coercing them.

Review `selector-wait.ts` first, then the backend wait branches. Conflicting state and boolean options are rejected rather than assigned an implicit precedence.

## Testing

- A scripted real headless Chromium page exercised all four states and both Puppeteer forms, five times each, on main and this branch. Both disappearance states timed out on main; all 30 branch calls resolved.
- The two real-worker regressions failed on main (hidden-state timeout; unknown options accepted) and passed with the fix. The focused worker, Tern and cmux test files passed, with the desktop-only test skipped.
- Re-run: `bun test packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts packages/coding-agent/test/tools/browser-tern-tab.test.ts packages/coding-agent/test/tools/browser-cmux-page-text.test.ts`.
- `bun run check:ts` stopped at an existing formatting error in `packages/coding-agent/test/agent-session-async-delivery.test.ts`; lint reported no errors and the workspace `check:types` phase passed when run separately. No desktop browser or model calls were used.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution
