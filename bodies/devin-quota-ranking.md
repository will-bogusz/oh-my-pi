## What

I have a Devin Pro and a Devin Max subscription under one email, and I want omp to use up the plan quota on both before it touches the on-demand balance.

With two Devin logins, omp now prefers a login with quota left: in a live check against two real logins, 16 of 40 new sessions went to the one whose weekly quota was spent on `main`, and 0 of 40 with this PR.

| Two Devin logins | `main` | This PR |
|---|---|---|
| One login's quota spent, it has an on-demand balance; the other has quota left | New sessions split between them by session id; the spent one keeps billing its balance | Sessions go to the login with quota left |
| A session automatically pinned to the spent login | Stays there | Moves on its next request |
| Both spent, only one has a balance | Sessions split between them | The funded login serves; the other is skipped until its quota resets |

**Beyond the fix:** while the balance funds it, a quota window at 100% shows as a warning rather than exhausted in `/usage`, as Codex credit overage already does, and `/usage` lists the Devin models the quota covers, as for other providers with a ranking strategy.

> **Devin context.** Pro and Max plans report a daily and/or weekly quota as a percent. Past it, Devin keeps serving from the account's [on-demand credits](https://docs.devin.ai/admin/billing/self-serve#how-quotas-work); with none left, it pauses until the quota refreshes.

## Why

Devin had a usage provider but no ranking strategy, so without account policies credential selection never read usage for it and each session kept the login its session id hashed to.

Decisions:
- Only the daily and weekly quota windows can block a login or count as its renewable allowance. Credit buckets are plan-period balances; letting them block would refuse logins `main` serves. A plan reporting no quota window keeps its credit buckets in the reserve check, as on `main`.
- A window at 100% stays serviceable while the balance is positive, the rule `openai-codex.ts` uses for credit overage; the existing spent-allowance step in `rank.ts` puts that login behind any sibling with quota left. A live quota error from Devin still blocks, as on `main`.
- The usage cache version is bumped, so a report cached before this change cannot block a funded login.

Non-goals: storing an identity on Devin logins or splitting `/usage` per organization, a plan order among logins that both have quota (drain order applies, as for other providers), new settings. With an auth broker, usage reports pair to logins by stored identity, which Devin logins lack, so this ranks logins in the local credential store. When every login is blocked, selection's existing last resort still returns one.

Related: #13878, #13884

Review first: `devinRankingStrategy` and `devinQuotaLimit` in `usage/devin.ts`.

## Testing

- Live, local credential store, two real Devin logins under one email (Pro: weekly quota 100% used, with a balance; Max: partly used), `AuthStorage.keys.get("devin", …)` for 40 fresh session ids: `main` 24 Max / 16 Pro, this PR 40 / 0. An automatic pin on Pro stayed on `main` and moved to Max with this PR.
- `bun test packages/ai/test/devin-account-usage.test.ts`: two *Devin login ranking* cases with canned `GetUserStatus` replies. Reverting `packages/ai/src` fails both; reverting only the 100%-stays-a-warning rule fails the both-spent case; letting credit buckets gate or count as allowance fails the first.
- Not run: an auth-broker setup.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
