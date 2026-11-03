## What

I fixed window lookup by application ID so an app discovered with `computer.apps.list()` can be used directly in a window filter.

`computer.windows({ app })` and `computer.window({ app })` fall back to exact application IDs and paths when no window's app name matches, using running process identity. A title miss still lists the requested app first instead of incorrectly suggesting that it has no windows.

## Why

Passing a macOS bundle ID to either lookup returned no match even with the app's windows open: only its display name was searched. Identity matching is case-insensitive and exact, not an ID substring heuristic. Platforms without process attribution keep name matching.

Application discovery scans installed apps before applying `runningOnly`: read-only macOS probes took 420–690 ms warm and 961 ms on a fresh process, with one cold outlier at 13 s. Name matching therefore keeps its existing fast path, including title misses; only an unmatched app name requires one inventory call per pass. Waiting refreshes PIDs each iteration rather than caching across launches. No native backend changes or app-specific rules.

## Testing

- Extended the existing filtering, title-miss ranking, and fake-timer wait tests. All three fail with the implementation reverted to `origin/main`; `bun test packages/coding-agent/test/tools/computer.test.ts` passes all 140 tests with the fix.
- Review regression checks: the same tests initially exposed five inventory calls instead of three and a name/title lookup failing when inventory threw. Both pass after restoring the name-only fast path.
- Read-only native `listApplications({ runningOnly: true })` and `listWindows()` on macOS, then the branch's shared app matcher: `com.apple.finder` matched zero windows by display name and one by process identity. No input, capture, activation, or launch.
- `bun run --filter './packages/*' --sequential --if-present check:types` passes. `bun run check:ts` stopped on formatting, including existing issues in `interactive-click-focus.test.ts` and `packages/tui/src/tui.ts`; touched files were formatted.
- Not run: live Windows/Linux lookups (no desktop session on those platforms), or model step-count comparisons; no prompt wording changed.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
