## What

I hit this with Factory Droid: a refresh whose whoami lookup answered after the 10 s budget left the store holding a refresh token WorkOS had already rotated away, so the next refresh failed with `invalid_grant`. A leased OAuth refresh that runs past its caller's budget now finishes and saves the rotated token.

`OAuthRefresher.refreshStored` used one 10 s timer for two jobs: it gave the caller its timeout error, and it aborted the signal handed to the token exchange. Now they are separate:

- **Caller budget** (`refreshTimeoutMs`, default 10 s): it covers both waiting on another process's lease and the exchange itself. When it runs out, the caller gets the same `timeout` `OAuthError` and its `onRefreshFailure` / `keepCredentialOnRefreshFailure` policy runs as before. Peers waiting on a lease another process holds also give up at their budget.
- **Exchange:** it runs as its own tracked task. It holds and renews the row lease, saves the result with a compare-and-set (CAS) update, reloads the credential pool from the store so siblings removed in the meantime stay removed, and releases the lease.
- **Backstop** (60 s, or the budget if that is longer): it aborts the exchange's signal and stops waiting for the exchange even if the provider ignores the abort, which releases the lease. To make the abort reach the token request, the broker's non-MCP refresh path and Cursor's token refresh now forward the signal.

Single-flight, lease fencing, CAS and disabling a credential on a definitive failure are unchanged. On shutdown, the drain waits for exchanges still in flight, but the process cleanup deadline (10 s) still cuts off longer ones.

## Why

Providers that rotate the refresh token on every grant (for example WorkOS, behind Factory Droid) invalidate the stored token as soon as the grant answers. The refresh path's own comment already says a leased exchange must finish and save any rotated token; the 10 s timer aborted it too early.

## Testing

- `packages/ai/test/oauth-refresh-budget-keeps-rotated-token.test.ts` uses a real SQLite store and mocked `fetch`. Its cases:
  - a rotated token is saved after the caller times out;
  - a peer waiting on a held lease gives up within its budget without exchanging;
  - a sibling removed during the exchange is not put back in the pool.
- `packages/coding-agent/test/mcp-manager-oauth-refresh.test.ts` (fake timers) now pins the new contract. The caller proceeds at 10 s with the stored token. Only the 60 s backstop aborts the fetch, and it releases the lease while the fetch still ignores the abort.
- `mcp-broker-oauth-refresh.test.ts` checks that the broker forwards the refresh signal to the provider's token request.
- On the code before this change, the rotation test, the updated MCP test and the broker test fail.
- The `packages/ai` suite, the coding-agent auth/MCP refresh tests and root `bun run check:ts` pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
