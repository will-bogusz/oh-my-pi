## What

I couldn't tell whether a Devin turn ran on plan quota or on overage money, even though Devin reports both on every turn and omp was just dropping them, so this keeps them and shows the totals in `/session`.

| Surface | Before | Now |
|---|---|---|
| A Devin turn's `usage` | token counts and the legacy credit meters only | also `credits.quotaPercent` and `credits.overageUsd`, as Devin reported them |
| `/session` Cost | nothing about quota or overage | `Quota: 0.35%` and `Overage: $0.12`, summed over the turns that reported them |
| RPC `get_session_stats` | `credits` with the three credit meters | same, plus optional `quotaPercent` and `overageUsd` (TS, Python, Rust and Go SDKs regenerated) |

**Beyond the fields:** the three legacy credit lines in `/session` now print only when one is nonzero, so a quota-billed session does not show `Credits: 0` three times; on `main` they only ever appeared with a nonzero meter.

> **Devin context.** Paid Devin plans include a daily and weekly usage quota; past it, turns draw on a prepaid overage ("extra usage") balance. Each chat response says what that turn billed to each: `committed_quota_cost_basis_points` and `committed_overage_cost_cents`.

## Why

Today a Devin user cannot tell whether a turn was covered by the plan or spent overage money until the balance drops in `/usage`. The fields arrive next to the credit meters omp already maps onto `usage.credits`, so they follow that path end to end.

- `usage.cost` is unchanged: it stays the API-equivalent estimate #12204 seeded for plan-included Devin models. Showing the overage charge as the cost would make every quota-paid turn read $0, a separate display question.
- A reported zero is kept (`Overage: $0.00` means no overage); a turn that reports nothing adds nothing.
- No status-line change. Subagent turns still do not roll credits into the parent `/session`, same as the existing meters.

<details><summary>Reading order</summary>

`streamDevin` in `providers/devin.ts` (decode), `SessionStatsTracker.getSessionStats` (sum), `handleSessionCommand` (render), `SessionCredits` in `rpc/wire/state.ts` (wire).

</details>

## Testing

- Recorded-frame tests in `packages/ai/test/devin-router.test.ts` and `packages/coding-agent/test/agent-session-stats.test.ts`; all three fail with the source change reverted.
- Branch TUI against a local Devin Connect edge serving one quota-paid and one overage-billed turn: `/session` shows `Quota: 0.35%` and `Overage: $0.12`; `main` shows no Cost section. `get_session_stats` returned `{"cost":0,"committedCost":0,"acuCost":0,"quotaPercent":0.35,"overageUsd":0.12}`.
- Live `swe-1-6-slow` turn: the response carries neither field and `usage.credits` stays unset.

Not run yet: a live turn Devin billed to quota or overage. This stays a draft until one confirms the fields arrive populated.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
