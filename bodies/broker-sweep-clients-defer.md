## What

Once my auth broker spent saved resets itself, every session connected to it kept running its own sweep too, listing the same accounts and asking about resets the broker would handle. This PR has those sessions step back.

| Capability | Behavior |
|---|---|
| Wire | a broker that sweeps answers `/v1/usage` with `resetSweep: ["openai-codex", "anthropic"]`, only to clients that send the new `reset-sweep` capability |
| Client | `AuthStorage.resets.brokerSweeps(provider)` reads it; a session skips its background sweep for those providers |
| `omp usage` | the 24-hour expiry banner says `→ the auth broker handles these resets; its host's <setting> and account policies decide whether this one is spent`, and neither promises a spend nor counts that reset toward "and will be lost" |

Blocked-turn restores and `/usage reset` are unchanged: a session at a 429 still restores itself.

Reading order: `UsageResponse.resetSweep` and the capability gate in `auth-broker/server.ts`, `RemoteAuthStore.brokerSweepsResets`, `sweepsResets` in `session/auto-reset.ts`, the banner branch in `formatResetExpiryBanner`.

## Why

**Merge after #15134, #15131, #15133, #15129, #15143.** The diff carries those bases (#15143 at `aafb01eb87`, which brings the other four: #15133 `4f585fc170` with #15134 `3243b8d268`). This PR's own work is `cd78af2b32`, `2f5585122e`, `97d15b4457`, `c5f46e4b79`, `76a58e8cce`, plus the conflict resolutions in its merges.

Without it, N sessions on one broker make N background sweeps over the same accounts, and the Claude listings among them are what trips Anthropic's usage rate limit.

The decision for a maintainer: should a session on a sweeping broker defer to the broker host's settings for background salvage? I think yes, since the broker is the one process that sees every account. I rejected putting the broker's `autoRedeem` mode on the wire: with per-account overrides (#15133) the client cannot see the broker host's account policies, so it would promise an outcome it cannot check. The client only learns which providers the broker covers, and the banner says who decides rather than what happens.

Older clients never get the field (they reject unknown `/v1/usage` fields), and an older broker never sends it, so mixed versions keep today's behavior.

## Testing

Live, mock endpoints with fake accounts, broker and client from this branch in scratch homes, a client session left open after `/usage`: 0 reset listings reached the mock, against 5 from the same client built from #15143 alone. `omp usage` on the client named the broker for the expiring Claude grant instead of this machine's setting, including for an account the broker host opted out (no spend promised).

Re-prove: `bun test test/auth-broker-remote-store.test.ts test/auth-broker-wire.test.ts` in `packages/ai`, `bun test test/claude-auto-reset-integration.test.ts test/usage-cli.test.ts` in `packages/coding-agent`. A session that ignores `brokerSweeps`, a server that never answers, or advertising the provider-wide mode instead each fails its test. `bun run check:ts` passes.

---

- [ ] `bun check` passes (ran `bun run check:ts`, not the Rust half)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
