## What

I wanted one Codex workspace to cash in its expiring saved resets on its own while the other workspace on the same login never does, and one `autoRedeem` per provider can't say that.

An `auth.accountPolicies` entry can now set `autoRedeem: true` or `false`, overriding `codexResets.autoRedeem` / `claudeResets.autoRedeem` for that one account in both directions; accounts without it follow the provider.

| Surface | main | this PR |
|---|---|---|
| Expiry salvage, 5-minute last chance, blocked-turn restore | every account follows the provider's `autoRedeem` | `true` spends without asking even under `no` or `unset`; `false` never spends; the rest follow the provider |
| Consent prompt (provider `unset`) | lists every planned spend | lists only accounts that follow the provider, and its Yes approves only those; Yes/No still saves the provider setting |
| `/usage reset` | spends on request | unchanged |
| `omp usage` policy line | `policy: priority 0 · reserve 10% (global) · eligible` | adds `· auto-redeem on` or `· auto-redeem off` |
| `omp usage` expiry warning | words from the provider setting | words from the account's policy when set, citing `(auth.accountPolicies autoRedeem: true)`; an account turned off counts toward "and will be lost" |

Reading order: `effectiveAutoRedeemMode`, both planners, `AgentSession.#confirmAutoRedeem`, `#executeResetActions`, `resetSpendVerdict`.

## Why

Today the only switch is per provider: `no` also stops omp rescuing resets on the account you want rescued, and `yes` spends a borrowed account's (one shared through `omp auth-broker`).

The decision for a maintainer: should `auth.accountPolicies` carry a per-account `autoRedeem` that wins over the provider setting in both directions? Policies already match exactly one stored account. I rejected an include/exclude list under `codexResets` (a second selector syntax) and an opt-out-only field (it can't say "only this account, without asking").

A policy change also reaches a spend already waiting on the prompt, another process's lock or Codex's balance recheck; the skipped account stays retryable. Each spend keeps its own approval, so a Yes for one account never spends another whose policy was removed meanwhile. Policies come from the spending process's settings, so on a broker client the client's config decides. Not goals: per-account `salvageHorizonHours` / `keepCredits`, or broker-enforced policies.

## Testing

Live, mock Codex and Claude endpoints with fake accounts (sandboxed scratch agent dir): both providers at `autoRedeem: no`, two Codex workspaces on one email and two Claude organizations, each with a reset expiring in 4 minutes, interactive omp open 30 s.
- `autoRedeem: true` on one Codex workspace and one Claude organization: exactly those two resets consumed (mock request log), no prompt.
- Same config without the policies: nothing consumed.

Read-only on real Codex accounts at `no`: `omp usage --provider openai-codex --redact` shows `auto-redeem on` / `off` on the two policy lines.

Tests cover each rule in both planners, the session (sweep under `no` and `unset`, a prompt listing only the sibling, a blocked turn restored under `no`, an opt-out landing after planning, behind an earlier spend or while the prompt is open) and `omp usage`. Reverting each behaviour alone (override, sweep and blocked gates, spend-time recheck, retry bookkeeping, per-action approval, throttled-listing wait, verdict, policy line) fails its own tests.

Re-prove: `bun test codex-auto-reset claude-auto-reset usage-cli` in `packages/coding-agent`, `bun test auth-broker-config-discovery auth-storage-codex-selection` in `packages/ai`, and `bun run check:ts`.

<details><summary><code>omp usage --redact</code> against the mock, resets 6 hours out: both providers at <code>autoRedeem: no</code>, one Codex workspace and one Claude organization at <code>true</code></summary>

```
▲ 4 saved resets expire within 24h
  Codex · mo*x@* · ws*l* · plan: pro · 1 expires in 5h59m (Oct 10 03:50) · 5 hours 95% used
    → an open interactive omp session spends it by its last 5 min if eligible then  (auth.accountPolicies autoRedeem: true)
    or now:  /usage reset openai-codex/1 in omp
  Codex · mo*x@* · ws*b* · plan: team · 1 expires in 5h59m (Oct 10 03:50) · 5 hours 100% used
    → not spent automatically  (codexResets.autoRedeem: no)
    spend it:  /usage reset openai-codex/2 in omp
  Claude · mo*a@* · or*a* · 1 expires in 5h59m (Oct 10 03:50) · Claude 5 Hour 100% used
    → an open interactive omp session spends it by its last 5 min if eligible then  (auth.accountPolicies autoRedeem: true)
    or now:  /usage reset anthropic/3 in omp
  Claude · mo*b* · or*b* · 1 expires in 5h59m (Oct 10 03:50) · Claude 5 Hour 100% used
    → not spent automatically  (claudeResets.autoRedeem: no)
    spend it:  /usage reset anthropic/4 in omp

Openai Codex — 2 accounts
  ● mo*x@* · ws*l* · plan: pro · ✦ 1 saved reset · ▲ 1 expires in 5h59m
      policy: priority 0 · reserve 10% (global) · auto-redeem on · inside reserve · 5.0% left
  ● mo*x@* · ws*b* · plan: team · ✦ 1 saved reset · ▲ 1 expires in 5h59m
      policy: priority 0 · reserve 10% (global) · exhausted · 0.0% left
```

</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)

