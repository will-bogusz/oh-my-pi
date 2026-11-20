## What

I kept a few sessions open for a couple of days, and when Devin started serving Gemini 4 Neon the quick model picker (alt+p) in those sessions never listed it, even though `omp models` in a new terminal did; this makes the picker catch up once its catalog is two hours old.

| Surface, session open for hours | Before | Now |
|---|---|---|
| alt+p quick picker | Only models discovered at startup (plus `models.yml` edits) | Also models a provider added since: discovery re-runs in the background once the last online refresh is 2 h old |
| `/model` hub | Re-runs discovery on every open | Unchanged |
| A new session, `omp models` | Current catalog | Unchanged |

The picker still paints at once from the in-memory catalog and re-syncs when the refresh lands, as it already does for a `models.yml` edit.

## Why

`ModelRegistry.refreshIfStale()` has one caller, the alt+p picker. It waited out an in-flight refresh and reloaded `models.yml` if the file changed, but never asked providers again, so the only ways to see a new model were opening `/model` or restarting. Discovery-backed providers (Devin, Cursor, Copilot, OpenRouter, custom `discovery:` entries) add models without an omp release, so this hits anyone who leaves sessions open.

Decisions:
- **Threshold is the built-in discovery cache TTL (`BUILT_IN_DISCOVERY_CACHE_TTL_MS`, 2 h).** Below it, a refresh would only replay the same cache rows, so an earlier trigger costs a catalog rebuild for nothing; the picker's "rebuild only when stale" contract holds inside the window.
- **`online-if-uncached`, not `online`.** A provider whose cache row another process refreshed (a newer session, `omp models refresh`) replays that row without a fetch; only expired ones hit the network. Errors stay logged by `refreshInBackground` as at startup, never a picker error.
- **Only after an online refresh already ran in this registry.** An SDK embedder or test that never went online stays offline.

Non-goals: `/switch <name>` and `--model` resolution still read the in-memory catalog; the hub's own refresh is untouched.

Review first: `refresh()` stamping `#lastOnlineRefreshAt`, and the new branch in `refreshIfStale()` (`model-registry.ts`).

## Testing

- **Live, Devin.** A registry built on this branch with a real Devin login, its cache row edited to drop the `gemini-4-neon` rows and backdated an hour, with the clock moved by `setSystemTime`: Neon absent at start, still absent from `refreshIfStale()` at +1 h (`false`), present at +2 h (`true`). The same script on `main`: Neon still absent at +2 h.
- **Regression test** `refreshIfStale picks up models another process discovered once the catalog is a TTL old` (`test/model-discovery.test.ts`): a second registry on the same cache discovers `new-model`; the first one's `refreshIfStale()` returns `false` without it at 2 h − 1 ms and `true` with it at 2 h. With the `model-registry.ts` change reverted it fails (`Expected: true, Received: false`).
- `check:types` for `packages/coding-agent` passes. `bun check` stops at `oxfmt --check` on 20 browser-relay and collab-web files this branch does not touch (the same on `main` at its base), so its box stays unticked.
- `bun test test/model-discovery.test.ts test/model-picker.test.ts test/model-hub.test.ts test/model-registry-*.test.ts test/selector-controller-settings-single.test.ts`: 333 pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
