## What

I made computer helpers reject misspelled options instead of quietly doing something different from what the caller asked.

Unknown option and filter keys now produce a `ToolError` naming the helper, the invalid keys and the valid names, with a spelling hint when there is one close match. Valid options keep their existing behavior; JavaScript `computer.run` also rejects keys it previously dropped.

## Why

`win.ax({ depth: 3 })` ignored the requested depth, `computer.windows({ includeOffscreen: true })` silently ignored the filter, and `win.scroll(x, y, { x, y, dx })` discarded the misplaced coordinates. The shared strict-object check catches these mistakes at the helper boundary rather than relying on native argument conversion, which cannot see keys a wrapper already discarded.

Allowed-key records are exhaustive against the TypeScript option types, so adding a field requires updating the corresponding accepted names. This changes invalid calls only; it does not add options or alter prompt text.

## Testing

On Linux, the worker regression failed against `origin/main` with `ax accepted depth`, `windows accepted includeOffscreen` and `scroll accepted x, y, dx`; it passes with the fix and exercises valid calls across desktop, window, element and display helpers. The run-argument regression also failed without the fix because an unknown key resolved successfully.

`bun test packages/coding-agent/test/tools/computer.test.ts packages/coding-agent/test/tools/computer-call.test.ts --timeout 20000`

`bun run check:ts`

Both focused test files pass: 147 tests, zero failures; `bun run check:ts` passes.

No model samples were needed: these are deterministic argument checks exercised through the shipped worker and JavaScript/Python facades.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
