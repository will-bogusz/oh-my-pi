## What

I made omp ride out an auth broker restart at startup instead of quitting on the first refused connection.

With the broker down for 3 s and no snapshot cache, startup failed after 8 ms on `main`; with this PR it starts at 3.5 s, once the broker is back.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/ab183bf8-28f4-48a2-9048-df10c0468a95">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/0732bed6-80f8-470c-b9f6-f44503485564">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/55be08cc-703b-4acc-b140-cee6a9792830">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/edf5b08f-ffbe-42b4-bbc6-dba9478987d2">
  <img width="780" alt="Timeline. The broker refuses connections from 0 to 3 seconds. On main, omp makes two attempts back to back at 0 s and startup fails after 8 ms. With this PR, omp retries after 0.5, 1 and 2 seconds, and the attempt at 3.5 s gets the snapshot, so the session starts." src="https://github.com/user-attachments/assets/0732bed6-80f8-470c-b9f6-f44503485564" />
</picture>

> **Auth broker context.** With `auth.broker.url` set, omp takes every credential from the broker, never its local store. Startup can use a snapshot cache under 1 h old; without one (a fresh machine, CI) it must fetch a live snapshot first.

When there is no usable cache, startup now retries the initial snapshot with backoff (0.5 s doubling to 8 s) under one 30 s deadline that also cancels a request in flight, but only for answers a restarting broker or its proxy gives: no connection, a timeout, or 5xx/408/429. A rejected token (401/403), a 404 or a malformed snapshot still fails at once; the fresh-cache path is untouched.

Non-goal: starting from an expired cache when the broker stays down; the TTL bounds how long a credential removed on the broker stays usable offline.

## Why

On `main` this path calls `fetchSnapshot()` once: two attempts back to back, no retry on an HTTP error. A broker restart, a proxy answering 503 meanwhile, or a few-second network blip ends the session before it starts; machines without a cache, such as benchmark VMs, lose the whole run.

Decisions:
- The retry lives in `fetchInitialSnapshot` (`discover.ts`), not the client's `maxRetries`, which covers every broker call all session and has no delay or HTTP retry.
- The 30 s deadline covers a service restart; a broker that is really off now fails after 30 s instead of at once, with the same recovery guidance and an error naming the retry window.
- Only startup retries (`retryUnreachableBroker`, set by `discoverAuthStorage`). Changing `auth.broker.url` mid-session still fails on the first error and keeps the current store, so a later settings change never queues behind a retrying one.

Related: #11073 (fresh-cache revalidation) and #19236 (a running session after a restart).

## Testing

- Live, from this branch: a real broker started 3 s after a client with `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS=0`. `main`: `startup FAILED at +8ms: Auth broker request failed after 2 attempt(s)`. This PR: `startup OK at +3518ms`, credential read through the broker. With the broker never starting, startup fails at +30.0 s: `Auth broker gave no initial snapshot after retrying for 30s: …`.
- `bun test packages/coding-agent/test/auth-broker-snapshot-cache.test.ts`: 6 pass. With the fix reverted, "retries the initial snapshot while the broker restarts" (a proxy answers 503 once, then forwards to a real broker) fails. Two more cases pin the edges: a 401 at startup, and a 503 on a mid-session switch, each fail after one request; a broker that accepts connections and never answers keeps startup waiting up to 29 s of fake time and fails at 30 s (hangs on `main`).
- `bun run check:types` in `packages/ai` and `packages/coding-agent`: clean.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
