## What

I run `omp auth-broker serve` on one machine for all my accounts, and a saved reset can still expire unused there, because only an open session ever spends one. This PR makes the broker spend them itself.

| Capability | Behavior |
|---|---|
| Broker sweep | `omp auth-broker serve` plans and spends saved Codex and Claude resets on its host's `codexResets.*` / `claudeResets.*` settings and `auth.accountPolicies`, waking at the next credit's last-chance window (5 minutes before expiry) or hourly |
| Default `autoRedeem: unset` | the broker has no prompt, so it follows #15131's headless rule: spend only a credit in its last 5 minutes; approvals keep the planner's order |
| Outages | a missing usage report or a failed listing keeps the known credit on the schedule, so the minute retry continues through its last 5 minutes |
| Off switch | `autoRedeem: no` on the broker host turns a provider off; an account policy `autoRedeem: true` (#15133) keeps that account on |
| Claude listing | screened from the usage reports' inventory first (#15129); one live listing only when something is due |

Reading order: `sweepResets` and `redeemConsentedResets` in `session/auto-reset.ts` (the planner and executor moved out of `AgentSession` so the session and the broker share them), `BrokerResetSweeper` in `session/broker-reset-sweep.ts` (wake schedule, retry), its start in `cli/auth-broker-cli.ts`.

## Why

**Merge after #15134, #15131, #15133, #15129.** The diff carries those bases (#15129 `feb93cf481`, #15131 `6ed93c39f2`, #15133 `4f585fc170` with #15134 `3243b8d268`). This PR's own work is the non-merge commits from `5427913ca0` on, plus the merge resolutions porting each base's planner and consent change into the shared module.

A broker host is the one process that is always up, and it already fetches every account's usage. Without this, a reset that expires while no session is open is lost, and with several sessions open each one sweeps the same accounts.

The decision for a maintainer: should the broker sweep by default when serving, with no new flag? The existing settings already say it: `autoRedeem: no` stops it per provider, and under `unset` it only rescues credits that would otherwise expire unused. I rejected a `--no-reset-sweep` flag (a second switch for the same choice), a fixed 5-minute timer (it lists accounts that have nothing due), and a separate refactor PR for the executor move (the move has no caller without the sweep).

Not a goal: sessions on a sweeping broker still sweep too; the follow-up stacked on this one stops that.

## Testing

Live, mock Codex and Claude endpoints with fake accounts, broker from this branch in a scratch home, `autoRedeem` unset, one Codex credit 4 minutes from expiry and others hours or days out: the broker's first sweep made exactly one consume, for the 4-minute credit.

Read-only over a real broker's `omp usage --json --redact` reports (2 Codex, 3 Claude accounts), the planners under `unset` planned no spend: nothing was within its window. Nothing was spent.

Re-prove: `bun test test/broker-reset-sweep.test.ts test/claude-auto-reset-integration.test.ts test/codex-auto-reset-integration.test.ts` in `packages/coding-agent`. Making `confirm` approve nothing fails all 6 spend tests; a constant hourly wake fails the last-chance and retry tests; dropping the retained schedule fails both outage tests; dropping the account policy from the planner and executor fails both override tests. `bun run check:ts` passes.

---

- [ ] `bun check` passes (ran `bun run check:ts`, not the Rust half)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
