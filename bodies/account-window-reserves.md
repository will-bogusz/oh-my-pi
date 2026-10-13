## What

I want one account to stop at 85% of its 5-hour window but 70% of its weekly one, and one `reservePct` per account can't say that.

An account policy can now set its reserve per usage window, keyed by the window id `omp usage --json` already reports (`5h`, `7d` for Codex and Claude):

```yaml
- provider: openai-codex
  account: { accountId: … }
  reservePct: 15                             # windows without an override
  windows:
    7d: { reservePct: 30, taperHours: 72 }   # weekly: 30%, released over its last 72 h
```

| Surface | Before | Now |
|---|---|---|
| Ranking, warm-pin eviction, usage health | one reserve compared with the lowest remaining window | each window compared with its own reserve and taper |
| `omp usage` policy line | `reserve 30%` | `reserve 15% (override) · 7d reserve 30%, tapers over 72h` |
| Typo in a window id | n/a | `weekly reserve 30% (no such window)` |
| Config parser, `AccountPolicies` | — | reject a non-object or empty map, padded keys, empty or unknown-field overrides, out-of-range values; `windows` needs a usage provider like `reservePct` |

Each field falls back to the account value, then the global setting; without `windows`, nothing changes. Reading order: `AuthAccountPolicy.windows` → `windowReserveFraction` → policy validation → `formatPolicyLine`.

## Why

**Merge after #14074.** #14074 adds `taperHours` and one helper, `windowReserveFraction`, that ranking, eviction, usage health and `omp usage` all call; this branch is built on #14074's commits and resolves the per-window override inside that helper, so it collapses to its own commit once #14074 lands.

**Decision for maintainers:** should one account's reserve be settable per usage window, as `windows: { <window id>: { reservePct, taperHours } }`? If not, an account stays on one `reservePct`, with #14074's taper as the only time-based release.

With one number, `reservePct: 30` reads "inside reserve" when the 5-hour window is 82% used and the weekly 51%; lowering it to 15 shrinks the protected weekly share instead.

- **Window id, not limit id.** Codex's `primary` limit is the 5-hour window on one plan and the weekly on another.
- **Not named fields** (`weeklyReservePct`): other providers report other windows.
- **Linear release, not a step.** A step hands the whole share over at once; it ran out about 8 h before reset in a simulation with the real selector. Linear is what #14074 ships.

Cost: one nested config field; older clients' strict parser rejects it. A misspelled id loads silently and is flagged only by `omp usage`, since window ids are known once a usage report arrives.

## Testing

- New tests cover the 5h and weekly boundaries, both sides of the linear release, inheritance, window-only reserves, ranking plus warm-pin eviction, the `omp usage` overrides and typo marker, and the rejections.
- `bun test test/auth-broker-config-discovery.test.ts test/auth-storage-codex-selection.test.ts test/auth-storage-model-usage-health.test.ts` in `packages/ai`: 154 pass. `bun test test/usage-cli.test.ts` in `packages/coding-agent`: 51 pass.
- Negative control: with this PR's source changes reverted, 13 ai tests and 1 usage-cli test fail; restored, all pass.
- Type checks pass for every package.
- Live, source build against a real usage report: `omp usage` printed `reserve 15% (override) · 7d reserve 30%, tapers over 72h · eligible` for an account the release build shows "inside reserve"; `omp dry-balance` sent it 20/20 new sessions.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
