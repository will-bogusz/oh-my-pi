## What

A login on my auth broker could keep failing to refresh and then lapse without a single warning, because transient refresh failures only ever logged at debug, so the broker now warns once the failure means the token will expire before the next try.

| Transient refresh failure (anything not read as an expired or revoked grant: timeouts, refused connections, other provider errors) | `main` | This PR |
|---|---|---|
| Access token outlives the next sweep (default: more than 60 s left) | `debug` | `debug` (unchanged) |
| Access token expires before the next sweep, or already has | `debug` | `warn` "auth-broker refresh failed (transient); access token expires before the next retry", with `expiresAt` and the error |

Definitive failures (`invalid_grant`, bare 401) already warn and disable the row; that path is unchanged.

## Why

The broker's background refresher (`AuthBrokerRefresher`) refreshes OAuth rows that expire within 5 minutes, every 60 s. When a refresh fails in a way `isDefinitiveOAuthFailure()` does not recognise, the row is kept and retried next sweep, logged at debug. That is right for one network blip, but a refresh that is broken for good and not classified definitive (Cursor's "Invalid User API Key" before #14753, for example) retried at debug until the access token expired, and then every minute after, with nothing above debug in the broker's journal. Requests served with that login fail from the moment the token lapses.

**Decision:** the threshold is the token's own expiry against the next sweep, not a count of failures in a row. It needs no per-row state in the refresher, stays quiet for a blip with time left to retry, and starts warning on the last attempt before the lapse, so the warning comes before requests fail rather than after. A login that stays broken warns once per sweep (once a minute by default) until it refreshes or is removed. The expiry is read from the row as stored after the failure, not as the sweep saw it, so a login that a peer refreshed or removed meanwhile stays at `debug`.

Non-goals: classifying more errors as definitive, and alerting outside the log (status endpoint, notifications).

## Testing

- `packages/ai/test/auth-broker-refresher.test.ts`: a new three-row case drives `AuthBrokerRefresher.tick()` against a real SQLite store with `refreshOAuthToken` rejecting `ECONNREFUSED` and a 60 s sweep: a token 30 s from expiry logs `warn`; one 2 minutes out logs `debug`; one 30 s out whose row a peer replaced with a 1-hour token during the refresh logs `debug`. With `refresher.ts` reverted to `main`, the `warn` row fails; judging by the sweep's stale expiry instead fails the peer row. File passes 9/9.
- Live: `omp auth-broker serve` from this branch and from `main` in a throwaway `HOME` with one Anthropic OAuth row (fake tokens) expiring in 30 s, HTTPS sent through a dead proxy so the refresh fails with `ECONNREFUSED` without reaching Anthropic. `main` logged `debug` "auth-broker refresh failed (transient)"; the branch logged the `warn` above with `expiresAt`.
- `bun run check:types` in `packages/ai`, `oxlint` and `oxfmt --check` on the changed files.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
