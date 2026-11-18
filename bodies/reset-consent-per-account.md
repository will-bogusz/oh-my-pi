## What


I want my Codex Team workspace to spend a saved reset when it hits its weekly limit while my Pro account and a shared login never spend theirs, and today the reset settings can only decide that for a whole provider.

An `auth.accountPolicies` entry can now set `autoRedeem5h`, `autoRedeemWeekly` and (Anthropic only) `autoRedeemFable` to `yes` or `no`. For that one account it replaces the provider's `codexResets.*` / `claudeResets.*` key of the same window, in either direction.

| Surface | Before | Now |
|---|---|---|
| Saved-reset spending (blocked restore, expiry salvage) | one `yes` / `no` / `unset` per provider and window | the same, unless the account's policy sets that window |
| Consent prompt | answer saved to the provider keys still `unset` | the same, never to a window an account policy decides |
| `omp usage` policy line | priority, reserve, reclaim | also `auto-redeem weekly yes`, from the stored account the reset planners attribute the report to |
| `omp usage` expiring-reset banner | verdict from the provider key | verdict from the key that decides it: `(account policy autoRedeemWeekly: no)` |

**Beyond the new keys:** two guards tighten for every account. A redeem whose stored row no longer shares the planned account's id or email, or whose Claude token resolves another organization than planned (a replaced credential store can reuse row ids), returns `no_account`; `main` spends whichever account the row holds. A throttled Claude reset listing is waited out only for an account in the session's pool; on `main` any account's throttle delays a blocked session.

Non-goals: a per-account `unset`, and a spend-time consent recheck (`main` has none).

<details><summary>Example</summary>

```yaml
auth:
  accountPolicies:
    - provider: openai-codex
      account: { email: me@example.com, orgId: <team workspace id> }
      autoRedeemWeekly: "yes" # spends at the weekly wall while codexResets.autoRedeemWeekly is no
    - provider: anthropic
      account: { email: shared@example.com }
      autoRedeemWeekly: "no" # never spends while claudeResets.autoRedeemWeekly is yes
```

</details>

## Why

Since a5530a29487, `unset` never spends without a prompt, so standing consent for one account means standing consent for every account of that provider. A team workspace next to a personal plan, or a borrowed login, needs opposite answers for the same window. Related: #13901.

**Maintainer decision: both directions, or narrow-only?** Narrow-only covers the borrowed login but not the team workspace; it is a small change (reject `yes` in `AccountPolicies` validation, drop account modes from `resetConsentEnabled`). I'd keep both: `auth.accountPolicies` already selects exactly one stored account, where a list under `codexResets` / `claudeResets` would add a second selector syntax.

Maintenance: a new saved-reset window needs one entry in `ACCOUNT_POLICY_RESET_KEYS`.

Reading order: `ResetConsent` and `credentialResetModes` (`codex-auto-reset.ts`) → `AgentSession.#resetConsent` and its callers → the planners' `window-disabled` checks → the `ResetCredits.redeem` guard → `reportStoredAccount` in `usage-cli.ts`.

## Testing

A session blocked on Pro (policy `no`) with Team (policy `yes`) also blocked spends only Team's reset, with no prompt, whether the provider key is `no` or `yes`; both rows fail without the per-account lookup. An earlier version (#15133) closed with three Codex findings open; each is now a test that fails with its fix reverted:

| Finding | Test |
|---|---|
| a replaced store reuses a row id | a row now holding another org (stored, or resolved live for a row stored without one), or an account sharing no id or email with the target: `no_account`, no reset request |
| throttled account outside the pool | blocked session lists once instead of waiting |
| Claude credential stored without its org | with one report: banner says "will be lost" by `account policy autoRedeemWeekly: no`; with two orgs' reports fitting it: attributed to neither |

Live: `omp usage` with an overlay giving Team `weekly: yes`, Pro `5h`/`weekly: no` and a Claude login `weekly`/`fable: no` printed those keys on the three policy lines.

<details><summary>Commands</summary>

```sh
cd packages/ai && bun test test/auth-broker-config-discovery.test.ts test/auth-storage-account-reclaim.test.ts test/auth-storage-claude-reset.test.ts
cd packages/coding-agent && bun test test/codex-auto-reset.test.ts test/claude-auto-reset.test.ts test/codex-auto-reset-integration.test.ts test/claude-auto-reset-integration.test.ts test/usage-cli.test.ts
```

</details>

Not run: a live spend, which would consume a real saved reset.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)


