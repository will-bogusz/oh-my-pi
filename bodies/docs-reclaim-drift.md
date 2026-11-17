## What

I fixed the auth-broker doc so it stops telling you a running session never moves back to your preferred account, since `reclaimAbovePct` does exactly that.

`docs/auth-broker-gateway.md`, *How sessions choose and keep an account*, said a warm pin "does not move back when a higher-priority account recovers". The `auth.accountPolicies` row on the same page, and the code since #14237, say otherwise. The section now states:

| Case | Before (doc) | Now (doc, matching code) |
|---|---|---|
| Higher-priority account recovers, `reclaimAbovePct` set | pin stays | automatic pin moves back once the account ranking would pick next has a higher `priority` and at least `reclaimAbovePct` left |
| When that is checked | not said | every request, against the quota the provider counts for the requested model (for Anthropic, shared windows plus that model family's own), from a usage report refreshed about every five minutes, or the last good one while fetches fail |
| No `reclaimAbovePct` | pin stays | unchanged: pin stays |
| Explicitly chosen account | not moved by ranking or reserve | not moved by ranking, reserve or reclaim |

Docs only; no behaviour changes, so no CHANGELOG line.

## Why

Someone reading the pin section to decide whether to set `reclaimAbovePct` got the opposite answer from the key table above it. The rules live in `AuthCredentialSelector` (`automaticPinWouldBeEvicted` and the `reclaimReady` ranking field in `packages/ai/src/auth/select.ts`); model scoping comes from each provider's `scopeLimitsForReserve`, and the report age from `USAGE_REPORT_TTL_MS`.

## Testing

Checked each sentence against `origin/main` code at the symbols above. `packages/ai/test/auth-storage-account-reclaim.test.ts` pins the documented cases (moves back above `reclaimAbovePct`, stays without it, stays between reserve and threshold, never moves an explicit pin, no reclaim at equal priority): `bun test packages/ai/test/auth-storage-account-reclaim.test.ts`, 13 pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
