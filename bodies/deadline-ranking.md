## What

I want omp to max out whichever account's limits expire soonest, per model, so a plan's quota isn't left unused when its week resets.

This adds an opt-in `rankBy` field to `auth.accountPolicies`. When every account at one priority sets `rankBy: deadline`, omp uses first the account at that priority whose usable quota for the requested model expires first. Today it orders them by required drain.

```yaml
auth:
  accountPolicies:
    - { provider: anthropic, account: { email: a@example.com }, priority: 10, rankBy: deadline, reclaimAbovePct: 40 }
    - { provider: anthropic, account: { email: b@example.com }, priority: 10, rankBy: deadline, reclaimAbovePct: 40 }
```

Two Claude accounts at one priority (cases from the tests):

| Request | Account A | Account B | `main` serves | This PR serves |
|---|---|---|---|---|
| Fable | Fable weekly 80% used, resets in 1 d | Fable weekly 10% used, resets in 3 d | B | **A** |
| Opus | weekly 10% used, resets in 6 d | weekly 10% used, resets in 3 d | B | B |
| Any | weekly 50% used, resets in 5 d; a saved reset that clears it expires in 1 d | weekly 50% used, resets in 3 d | B | **A** |

An account's quota "expires" at the earliest reset among the windows of the kind omp already ranks this provider by. For Claude and Codex those are the weekly windows, and a Fable or Mythos request also counts its own weekly window. If the account holds an available saved reset that names one of those windows in `clears`, can be spent before the limit is hit, and expires sooner, that expiry counts instead.

**Running sessions.** Without `reclaimAbovePct`, a warm pin never moves. With it, a session pinned to an account at the same priority whose quota expires later moves to the earlier account once that one is above its `reclaimAbovePct`. This is what reclaim already does across priorities.

Non-goals: no change when `rankBy` is unset or `drain`. No provider-level setting. Codex saved resets don't count, because they don't say which windows they clear. `omp usage` does not show the field. Providers with no usage ranking refuse `rankBy: deadline` with a configuration error.

## Why

Required drain is headroom divided by hours to reset. It rates accounts by pressure, so a burst splits across them, and the account that resets first can still end its week with quota left. Today the only way to say "use whatever expires first" is to rewrite `priority` on a timer.

Decisions:
- **Per policy, all or nothing per priority.** A priority ranks by deadline only when every account at that priority opts in; a mixed priority keeps required drain. Deciding pair by pair would make the sort intransitive (A before B by deadline, B before C and C before A by drain). I chose not to add a provider-level setting: it would need new plumbing through the SDK, the gateway and live reload, while a policy field uses the existing path.
- **Every existing check still comes first.** Blocks, plan, spent allowance, reserve, the Codex boost, the hot 5-hour guard, `priority` and the usage-report check all decide before deadline. Deadline only replaces the drain tie-break.
- **Deadline comes from reset times, never from usage.** Which window omp's drain score treats as most pressured can change as usage grows, so the deadline doesn't use it: it takes the earliest reset. The order changes only when a window resets, a saved reset expires, or a check trips. Ranking compares deadlines to the minute, because providers report resets relative to the fetch and they jitter by seconds.
- **No flapping on reclaim.** Moving a warm pin within a priority needs both deadlines known and the winner's more than a minute sooner, plus the gap `reclaimAbovePct` keeps above the reserve. A session that leaves an account at its reserve comes back only after that account resets, and by then the account's deadline is a week away. A pin whose usage report is missing stays put.
- **Saved resets count** because spending one refunds everything used before it. This assumes the reset gets spent before it expires; omp's auto-redeem does that when the user has consented.

Related: #15843 (opt-in drain-based eviction of warm pins; this PR changes the ranking order instead and reuses `reclaimAbovePct`), #15469 (policies that expire, not added here), #17383 (OpenCode Go monthly-reset order, closed by its author).

Maintenance: nothing is provider-specific. A provider whose usage report has no reset time ranks that account a full window away.

Review first: the comparator slot in `rank.ts`, then `usableQuotaDeadline` in `usage-report.ts`, then the deadline priorities and the reclaim branch in `select.ts`.

## Testing

`packages/ai/test/auth-storage-account-reclaim.test.ts` runs the real `AuthStorage`, selector and Claude ranking strategy on synthetic usage with an injected clock:
- Fable and Opus requests on one pool go to different accounts, each by its own model's deadline. Using more of A's quota (no reset moves) keeps Fable on A.
- A priority where one account has no `rankBy` keeps `main`'s order (the off side).
- A saved reset that clears the week and expires first moves the deadline earlier. A reset that names no window does not.
- A warm session leaves A at its reserve and comes back once A is above `reclaimAbovePct` and expires first. It then stays on A for three more requests while B is also above its line, and stays again when A's usage report goes missing.

Negative control: with the `rank.ts`, `select.ts`, `usage-report.ts` and `policy.ts` changes reverted, 3 of these 4 fail. The off-side case passes both ways by design. `auth-broker-config-discovery.test.ts` adds the field to the config round trip and rejects an unknown value.

```
cd packages/ai && bun test test/auth-storage-account-reclaim.test.ts test/auth-broker-config-discovery.test.ts
```

All `auth-storage-*`, `auth-broker-*`, `claude-block-healing`, `usage*` and the affected usage-provider tests pass (688), as does `bun run check:ts`.
Not run: live accounts (that needs two subscriptions whose weeks reset at different times).

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

