## What

I made window selection prefer the app name I asked for, so Google Chrome for Testing no longer makes a Google Chrome lookup ambiguous.

Both `computer.windows({ app })` and `computer.window({ app })` prefer a case-insensitive exact app name when one is present. Without one, substring matching and the existing ambiguity error remain.

## Why

A lookup for `Google Chrome` currently also matches `Google Chrome for Testing`, so `window()` throws even when only one window belongs to the named app.

Exactness is decided over all listed windows, before title or id filtering, rather than only over title matches: a title that belongs only to the testing browser must not redirect a Chrome lookup there. The wait loop applies the same rule on every listing. Application ID/path lookup by PID and miss-list ranking are not changed.

## Testing

On Linux, the focused worker regression `prefers exact app names across all windows and keeps substring ambiguity otherwise` failed against origin/main plus the test (0 pass, 1 fail), then passed with the fix. It checks exact-name listing and selection, title misses without cross-app substitution, and ambiguity for the partial name `Chrome`.

`bun test packages/coding-agent/test/tools/computer.test.ts`: 144 passed, 0 failed, including ID/path and wait-loop coverage. Tests use fake native sessions; a copied Linux addon loads imports, not desktop operations. No native code changed.

---

- [ ] `bun check` passes
- [x] Tested locally (Linux worker tests)
- [ ] CHANGELOG updated with the required attribution (entry added; PR attribution is added when opened)
