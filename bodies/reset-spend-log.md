## What

I couldn't tell from any omp log which process had spent several of my saved resets in one day, so now every spend attempt leaves an info line saying which account, what triggered it and how it ended.

Every saved-reset spend attempt now writes one info line, `reset spend`, to the omp log, whatever its outcome. That covers automatic spends from the blocked-account pass and the salvage sweep, Claude and Codex, plus `/usage reset`, the reset picker and `omp usage reset`.

```
reset spend {"provider":"anthropic","account":"you@example.com","orgId":"…","credentialId":7,"creditId":"cedar-grant-1","trigger":"blocked","reason":"blocked-account","window":"weekly","code":"reset","cleared":["anthropic:7d"]}
```

## Why

On `main` a successful automatic spend only raises a transient notice, and `claude-auto-reset: plan` logs at debug, and only when it skipped something, so a spent reset leaves no trace. A reset is a scarce credit. The record changes nothing about when one is spent.

<details>
<summary>Details</summary>

- `trigger` is `blocked`, `sweep` or `manual`. `reason` is the planner rule (`blocked-account` or `expiring-credit`) and `window` is the window whose consent governed an automatic spend.
- `code` is the redeem's own code (`reset`, `already_redeemed`, `no_credit`, `offer_changed`, …), or `error` when the redeem threw. When nothing was sent, it is `fenced` (another omp process attempted within the cooldown; `marker` gives its state), `balance_spent` (the live Codex balance had already fallen) or `left_pool` (the session may no longer use the account).
- `account` is the credential's email or account id, the same identity the existing `codex-auto-reset`/`claude-auto-reset` warnings already log as `account`.
- Consent declines and adopting a peer's reset are not spend attempts, so they write nothing.
- Reading order: `session/reset-fence.ts` (`logResetSpend`), then `AgentSession.#executeResetActions` and `AgentSession.redeemResetCredit`, then `cli/usage-cli.ts`.

</details>

## Testing

- `bun test test/claude-auto-reset-integration.test.ts` in `packages/coding-agent`: the blocked-retry spend and the `omp usage reset` spend each assert their `reset spend` record (trigger, code, credential, credit). Both fail with `src` reverted to `main` and pass on the branch (23 pass). `codex-auto-reset-integration` passes unchanged.
- `bun run check:types` in `packages/coding-agent` passes.
