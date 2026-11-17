## What

<!-- Will: confirm own-words -->
I want the auth broker and every client to say which omp version they run and warn me when they differ, so a broker left on an older release stops being the last thing I suspect.

| Surface | `main` | This PR |
|---|---|---|
| Client log (`~/.omp/logs`) | nothing | one `warn` with both versions when the broker's version differs from the client's (again only if the broker's version changes) |
| `omp auth-broker status` | `OK <url> (version=18.18.6)` | `OK <url> (version=18.18.6) differs from this omp (18.22.1)`; `--json` adds `clientVersion` |
| Broker log | peer only | `snapshot served` and `stream opened` carry the client's version |
| Broker `clients` table | install id, hostname, first/last seen | plus `version`, from the client's own usage reports |

Nothing is refused on a mismatch: every request still runs as on `main`.

## Why

The broker is long-running and outlives client upgrades, so a mixed fleet is normal after any update. `/v1/healthz` reports the broker's version, but only `auth-broker status` reads it, and clients never send theirs. When an older broker serves newer clients, neither log says the versions differ, and the symptom (rows parsed differently, a 400 that quietly disables usage reporting) gets debugged as something else.

Decisions:
- **Headers, not body fields.** Request and response schemas reject unknown keys, so a version field in a body would break exactly the mixed pairs this is for. Clients send `x-omp-version` and `x-omp-install-id` (the identity header pi-native clients already send the gateway); the broker stamps `OMP-Auth-Broker-Version` on every response. Old peers ignore both.
- **Warn, never refuse.** Most version pairs work; a hard refusal would turn every rolling upgrade into an outage.
- **Recorded only for the sender's own row.** An auth-gateway reports usage for other installs over its own connection, so the broker writes the version only when the report's install id matches the sending client's.
- **Not on `/v1/usage/clients`.** That response schema is closed, so adding `version` there would break older clients reading a newer broker. The column is ready for it once client schemas tolerate new fields.

Non-goals: detecting brokers that predate this PR (they send no header; `auth-broker status` still compares against healthz), and any in-session TUI notice (the ai package has no notice channel to the session).

Related: #19236 (broker restart robustness), #19554 (the daemon broker, a different subsystem).

Reading order: `types.ts` header constants → `client.ts` `#noteBrokerVersion` → `server.ts` `withBrokerVersion` and the `/v1/usage/observed` handler → `sqlite-credential-store.ts` `clients.version` → `auth-broker-cli.ts` `runStatus`.

## Testing

- `bun test packages/ai/test/auth-broker-wire.test.ts`: 30 pass. The new test runs one client against a broker on the same version (no warning) and one against `0.0.1` (exactly one warning across `healthz` + snapshot, with both versions), then posts the client's own report and a relayed one: only the own row gets the version. With `server.ts` reverted, it fails. The migration test now also checks that a pre-version `clients` table gains the column.
- Live: a broker on `18.18.6` and `omp auth-broker status` from this branch printed `OK http://127.0.0.1:18799 (version=18.18.6) differs from this omp (18.22.1)` and logged the warning; against a broker on `18.22.1` it printed the plain `OK` line.
- `bun check:types` in `packages/ai` and `packages/coding-agent`; `oxlint` on the touched files.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
