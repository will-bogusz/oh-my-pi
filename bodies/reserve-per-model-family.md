## What


I want Fable to stop drawing on an account before it burns that account's last Fable quota for the week, without also holding Opus back on the same account.

An account policy can now give one usage limit its own reserve. `reservePctByLimit` maps a limit `id`, as `omp usage --json` lists it, to a percentage; every other limit keeps the account's `reservePct`:

```yaml
auth:
  accountPolicies:
    - provider: anthropic
      account: { email: me@example.com }
      reservePct: 2
      reservePctByLimit:
        anthropic:7d:fable: 30
```

| With this policy, Fable weekly row at 25% left, shared 7-day at 40% left | `main` | This PR |
|---|---|---|
| Fable request | served here (25% > 2%) | in reserve: ranks after siblings outside theirs, a warm pin moves to one |
| Opus request (not metered by the Fable row) | served here | served here |
| `retry.usageAwareFallback` health for Fable | healthy | reserve |
| `omp usage` policy line | `reserve 2% (override) · eligible · 40.0% left` | `reserve 2% (override) · anthropic:7d:fable reserve 30% · eligible · 40.0% left · Claude 7 Day (Fable) inside reserve` |

Without the map nothing changes: an account is in reserve when any limit that applies to the request is inside its own reserve, which with one reserve for all limits is `main`'s test on the most-used limit. Not in this PR: a hard stop (a reserve still only ranks an account last) and per-limit `reclaimAbovePct`.

## Why

`reservePct` is one number for every window of an account. Since #8774 a Fable request is judged against the Fable weekly row, but by the same reserve as the shared windows, so keeping Fable off an account's last 30% of Fable quota also held back 30% of its shared quota from Opus.

Decisions:
- **Keyed by the limit `id` from usage reports**, not a model family or a parsed `window:tier` string. Every provider's reports already carry ids (`anthropic:7d:fable`, Copilot's per-model rows, Antigravity buckets), so no model list lives in TS, and the key a user writes is the one `omp usage --json` prints. An id that never appears is inert.
- **A new optional key beside `reservePct`**, not a number-or-map `reservePct`, so readers of `reservePct` (`omp usage --json`, scripts that write policies) keep a number.
- **Reclaim skips an account inside its reserve.** `reclaimAbovePct` is still validated against the scalar reserve, so a limit's reserve can sit above it; without the guard, a session on a sibling that is itself in reserve was pulled onto the preferred account while that account was inside its Fable reserve. On `main` the guard changes nothing, since reclaim already had to be above the only reserve.
- **`omp usage` keeps the account's state on its shared windows** (#19606). A Fable reserve ranks only Fable requests, so it does not turn the account `inside reserve`; the Fable row is named beside the state, as #19606 names a spent one, and JSON lists it in `scopedInsideReserve`. A map entry for a shared window (`anthropic:7d`) does decide the state.

Related: #14074 and #19323 shrink a reserve as a window's reset nears; this sets which reserve a limit starts from, so either composes with it.

<details><summary>Reading order</summary>

`usageLimitReserveFraction` (`auth/types.ts`) → `isAnyUsageLimitWithinReserve` (`usage.ts`) → its callers: ranking and `reclaimReady` in `auth/select.ts`, pool health in `auth/health.ts`, `computePolicyDiagnostics` in `cli/usage-cli.ts`; validation in `auth/policy.ts` and `auth-broker/discover.ts`.
</details>

## Testing

- Two Claude accounts through `AuthStorage.keys.get`: an Opus request stays on the higher-priority account, and the same warm session's Fable request moves to the sibling. Further cases cover Fable health `reserve` with Opus `healthy`, no reclaim onto an account inside a limit reserve, config parse and rejection, and the `omp usage` JSON and policy line. With the source reverted every new case fails.
- `omp usage -p anthropic` from this branch with the policy above in a config overlay, against two real Claude accounts: the policy line and `--json` carry `reservePctByLimit`.
- Not run: a live Fable request, to avoid spending Fable quota; the `keys.get` test covers routing.

<details><summary>Commands</summary>

`packages/ai`: `bun test test/auth-storage-claude-fable-fallback.test.ts test/auth-storage-model-usage-health.test.ts test/auth-storage-account-reclaim.test.ts test/auth-broker-config-discovery.test.ts test/auth-storage-codex-selection.test.ts`; `packages/coding-agent`: `bun test test/usage-cli.test.ts`; `bun run check:types` in both.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


