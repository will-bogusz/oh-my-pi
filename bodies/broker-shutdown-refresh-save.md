## What

Restarting my auth broker while it was mid-refresh could throw away the token the provider had just rotated, so I made `serve` let the existing refresh drain finish before the process exits.

`omp auth-broker serve` stopped by SIGTERM or Ctrl-C now exits only after a login refresh already in flight has saved its new token (up to the existing 125 s wait). Before, it could exit with the old, already spent refresh token still in the store, and that login was disabled on its next refresh.

> **Refresh context.** Many OAuth providers rotate the refresh token on every refresh: once the exchange returns, the old one is dead. omp already holds process exit open for an in-flight refresh so the new token gets written (the `oauth-refresh` cleanup in `packages/ai/src/auth/refresh.ts`, run by the CLI's signal handler).

## Why

`serve`'s signal handler ran `await handle.close(); storage.close(); process.exit(0)`. The CLI entry also installs omp's process signal handler, which runs the cleanup pass, refresh wait included, and then exits. `process.exit(0)` won that race as soon as the listener closed, and `exit` listeners cannot await, so the pending save was dropped. A supervised broker restarts on every upgrade, so each restart risked a login.

The handler now closes the listener and the store (whose close already waits for tracked refreshes) and returns from `serve`; the process signal handler owns the exit, as it already does for `omp auth-gateway serve`.

Decisions:
- Return instead of exiting, rather than awaiting the refresh drain inside `serve` and keeping `process.exit(0)`: the drain and its deadline already live in the cleanup pass, and a second exit path is what raced.
- Exit status is now always the signal handler's (143 for SIGTERM, 130 for SIGINT), as it is for every other omp command; under systemd the old race already made that handler's 143 win most stops.

Non-goals: the gateway's in-flight model streams on stop, and service managers' stop timeouts (the docs now say one must exceed the 125 s wait).

## Testing

- New `packages/coding-agent/test/auth-broker-serve-shutdown.test.ts` spawns the real `omp auth-broker serve` on an isolated home with an expiring MCP OAuth row whose token endpoint is a local server. When the broker's startup refresh reaches it, the test sends SIGTERM, waits for the `auth-broker shutting down` log, answers with a rotated token, and asserts it is in `agent.db` after exit. With `main`'s `auth-broker-cli.ts` it failed 8 of 8 runs (`original-refresh` stays); with the fix it passed all 13 (Linux).
- Live, nothing in flight: `serve` exits within about half a second on SIGTERM (143) and SIGINT (130).
- `bun run check:ts`; the new test plus the broker tests that import `auth-broker-cli.ts` (`auth-broker-import`, `auth-broker-migrate`, `mcp-broker-oauth-refresh`, `security/auth`).
- Not run: Windows (the test is skipped there, since `kill("SIGTERM")` terminates the child outright) and macOS.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
