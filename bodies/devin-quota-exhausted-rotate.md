## What

My Devin sessions kept failing with "weekly usage quota has been exhausted" while my other Devin login still had quota, so this makes omp treat that refusal as the login's usage limit and move the session to a login that can still serve.

| Devin refusal (statusless Connect trailer) | `main` | this PR |
|---|---|---|
| `Your daily usage quota has been exhausted. Your quota will reset after 1s.` | switches login | switches login |
| `Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.` | every request fails on the spent login | switches login |

The change is one phrase, `(daily|weekly) usage quota has been exhausted`, in `USAGE_LIMIT_PATTERN` (`packages/ai/src/error/rate-limit.ts`). `isUsageLimitOutcome` (rotation) and `classify` in `error/flags.ts` (`Flag.UsageLimit`) both read it through `matchesUsageLimitText`, so they agree.

**With one Devin login stored:** the weekly error still ends the turn and later prompts still get it. New is the usage-limit path's usual fail-fast notice (`Retry requires 1800000ms wait, exceeds retry.maxDelayMs`), as for any usage limit with no reset hint.

## Why

Devin's refusals arrive in the end-of-stream Connect trailer with no HTTP status, so only the wording can mark them. The matcher knew the daily form only through its `quota will reset` suffix; the weekly form names no reset time.

Per [Devin's billing docs](https://docs.devin.ai/admin/billing/self-serve#how-quotas-work), on-demand credits keep a login working past its allowance, and sessions pause only when that balance is empty too. The spent login's block is the existing one: 30 minutes (`QUOTA_EXHAUSTED`), extended to the weekly reset when its usage report shows the allowance spent. `devinQuotaLimit` reports a funded login at 100% as a warning, so a funded login is never extended. No new setting, nothing in the Devin provider.

`quota will reset` stays: Gemini CLI and Antigravity use it without the new phrase.

Related: #5912 (configurable fallback account on a limit; not closed by this).

## Testing

- `agent-session-retry-cap.test.ts`, "moves a Devin session off a login whose weekly quota is spent": two stored logins, the first one refuses every request with the weekly trailer; the turn ends answered on the other. Fails on `main` (`stopReason` `error`).
- `rate-limit-utils.test.ts`: "Usage quota has been exhausted for this per minute window" on a 429 stays out of rotation.
- Unchanged from `main`: Devin's daily and "Reached overall message rate limit" trailers, Google's "Resource has been exhausted (e.g. check quota)", "Rate limit will reset in 30 seconds", "Too many requests", Vertex concurrent-requests quota.
- Live, `swe-1-6`, my two real logins in an in-memory store (Max at 100% of its week with no on-demand balance, Pro with quota left), session pinned to Max, usage endpoint withheld so selection cannot see Max is spent: `main` ends with the weekly error on Max; this branch ends "Ok" on Pro.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
