## What

Setting `OMP_LOG_LEVEL=info` on my auth broker did nothing to its journal, because the level only ever applied to the log file, so I made it gate the console output too.

With `OMP_LOG_LEVEL=info`, a broker that serves snapshot streams printed 6 debug records out of 18 on `main` and prints 0 of 12 with this PR; unset, it prints everything as before.

| `OMP_LOG_LEVEL` | Log file (`~/.omp/logs`) | Console (`omp auth-broker serve` stdout) |
|---|---|---|
| unset | all levels (unchanged) | all levels (unchanged) |
| `info` | error, warn, info (unchanged) | all levels → error, warn, info |
| `warn` | error, warn (unchanged) | all levels → error, warn |

`emitLocally` now checks the level once for both local transports instead of only for the file. Sinks registered with `registerLogSink` (OTLP export) still get every record, as on `main`.

## Why

`omp auth-broker serve` logs to stdout only (`setTransports({ console: true, file: false })`) so systemd or pm2 captures it. Its journal is mostly debug: on one broker, about 230k debug lines against 49 warnings in three days, including a single "Auth credential disabled" warning when two logins dropped. `OMP_LOG_LEVEL` is omp's only log-level setting, but it reached only the file transport, which the broker turns off.

**Decision:** one level for both transports rather than a second variable for the console. `omp auth-broker serve` is the only command that turns the console transport on, and the interactive app keeps it off, so the only output that changes is a broker's that sets `OMP_LOG_LEVEL`.

Non-goals: changing which broker records are debug, and a per-transport level.

## Testing

- `packages/utils/test/logger-contract.test.ts`: a new `console-levels` probe scenario runs in a child process with a console-only transport. With `OMP_LOG_LEVEL=info` stdout carries warn and info only; with it unset, warn, info and debug, as on `main`. With `logger.ts` reverted to `main`, the `info` row fails (`console-debug` is printed). File passes 20/20.
- Live: `omp auth-broker serve` from this branch and from `main` in a throwaway `HOME` with one stored API key and `OMP_LOG_LEVEL=info`; three snapshot streams stay open while two more keys are stored, plus three `/v1/usage` polls. `main` printed 6 debug "auth-broker stream entry" records and 12 info; the branch printed the same 12 info and no debug.
- `bun run check:types` in `packages/utils`, `oxlint` and `oxfmt --check` on the changed files.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
