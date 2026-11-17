## What

I made the broker client read responses from a newer broker instead of throwing them away whole, so updating the broker before its clients no longer blinds them.

| An older client against a newer broker | On `main` | With this PR |
|---|---|---|
| Snapshot or SSE frame with one added field (top level, entry, block, refresher) | whole response rejected: no credential updates | field ignored, credentials read |
| `/v1/usage` with a new `unit` or `status` value | whole response rejected: every usage report `null`, ranking runs blind | that value reads as `"unknown"`, the rest of the report is used |
| `/v1/usage/history`, healthz, write acknowledgements with an added field | rejected | read |

| A newer client against a broker with this PR | On `main` | With this PR |
|---|---|---|
| `POST /v1/usage/observed` carrying a field the broker lacks | 400, and the client turns observed-usage reporting off until it restarts | accepted, unknown fields ignored |
| Credential upload, disable, block upsert, block delete with an unknown field | 400 | 400 (unchanged) |

## Why

Every response schema in `auth-broker/wire-schemas.ts` used `"+": "reject"`, and usage `unit`/`status` were closed enums, so any field or value a broker release adds broke every client one release older until it updated. Clients and the broker update at different times (a long-running gateway keeps its old binary), so that window is normal.

Decisions:

- **Writes stay strict.** A broker should not apply a credential upload, disable or block change whose fields it cannot read: an ignored field could widen what the write does. Only the observed-usage report is relaxed, since unknown fields there cannot change what gets recorded. `credentialBlockRequestSchema` is now `credentialBlockSnapshotSchema.onUndeclaredKey("reject")`, so blocks read from snapshots are tolerant while block POSTs keep their check; the API-key credential likewise stays strict on upload and is read leniently in snapshots.
- **Unknown enum values map to `"unknown"` rather than failing or being dropped.** Both `UsageUnit` and `UsageStatus` already include `"unknown"`, which providers emit today when they cannot classify a limit. The wire copy now reads through `usage.ts`'s `usageUnitSchema`/`usageStatusSchema`, so the duplicate enum strings are gone.
- **Undeclared keys are kept, not stripped**, matching what the OAuth credential and inner usage schemas already did.

Non-goals: `inferenceRegion` stays a closed enum, since reading an unknown region as absent would route a credential to the default region. A new credential `type` or SSE event `kind` still fails the response. Brokers released before this PR still answer 400 to an observed-usage field they lack.

The contract test rows that asserted envelope and enum rejection on responses are flipped to assert the new reading; the write-side rejections stay, and a block-request row with an extra key is added.

## Testing

Against a stub broker that answers a snapshot with added `jitterMs`, `quarantined` and block `origin` fields and a usage report with `unit: "seconds"`, `status: "throttled"`, `AuthBrokerClient.fetchSnapshot()`/`fetchUsage()` on `main` throw `Auth broker response failed schema validation … must be removed` / `… unit must be "percent", …`; on this branch both return, with the limit read as `unit: "unknown"`, `status: "unknown"`.

`bun test test/auth-broker-wire-schema-contract.test.ts test/auth-broker-wire.test.ts test/usage-report-notes-schema.test.ts test/remote-auth-store.test.ts test/auth-broker-remote-store.test.ts test/auth-broker-snapshot-cache.test.ts` (in `packages/ai`): 108 pass. With the `wire-schemas.ts` change reverted, the three new cases fail (newer-broker snapshot, usage enum mapping, observed-usage report with an extra field). `bun run check:types` in `packages/ai` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
