## What

With a Spotlight tab open, the stats dashboard froze for seconds after every sync, so I moved the Spotlight build onto its own worker and the other pages keep answering while it runs.

An Overview request sent during that rebuild now returns in 2 ms instead of 3.7 s, and `/api/status` in 2 ms instead of timing out; the Spotlight payload is byte-identical.

| During a Spotlight rebuild (1,135 real transcripts) | `main` | this PR |
|---|---|---|
| Overview request | 3.7 s | 2 ms |
| `/api/status` (2 s probe) | timed out, 3 of 3 | 2 ms |
| The Spotlight rebuild itself | 4.0 s | 4.2 s |

Reading order:

- `buildSpotlightDashboardJson` (`spotlight-aggregator.ts`), which `spotlightView` now calls: a fresh worker per build, terminated after its reply.
- `spotlight-worker.ts`: opens `stats.db` read-only and builds in one read transaction, so a payload is one snapshot while ingest writes.
- `server.ts`: the Spotlight route skips Bun's 10 s idle timeout, which a build on a full database (about 14 s) would hit now that the loop is free, and the process's last dashboard to stop ends running builds.
- `cli.ts`: the `__omp_worker_stats_spotlight` selector shares the sync worker's buffering (its `import()` calls follow the existing loaders); `omp --smoke-test` pings it.

Non-goals: the Spotlight tab still waits for its own rebuild, and the build is no faster.

## Why

`spotlightView` drops its cached views on every data-version bump, and a build is seconds of synchronous SQLite reads and analysis on the server's only thread. So after every sync, an open Spotlight tab held other pages, the live status stream and ingest.

- **Worker, not yielding inside the build.** A prototype yielding every 16 ms answered Overview in 4-13 ms, but one large session still stalled the loop for 239 ms, ingest could write mid-build, and the builder turned async.
- **Not invalidating only on Spotlight tables.** Nearly every transcript is an experiment session (1,171 of 1,173 here), so they change on almost every sync.
- **A fresh worker per build.** Its memory leaves with it; the spawn adds about 0.1 s to a 4 s build.

## Testing

- 1,135 real Spotlight transcripts in an isolated agent dir, each tree's server on its own port. Three rounds per tree: a page on `/api/events`, a new transcript lands, the version bumps, Overview and `/api/status` go out 300 ms into the rebuild. Six cold builds split the same way. Same through `omp stats` from source and a compiled macOS binary.
- Six views from both servers on one database are byte-identical.
- A worker held 15 s before building still answers 200, with `/api/status` at 0.5 ms meanwhile.
- `omp --smoke-test` passes from source, the binary and `dist/cli.js`; with the selector renamed it fails.
- `test/spotlight.test.ts`: the route never reads the server's connection and matches the on-thread payload; a build survives stopping one of two dashboards and ends with the last. Both fail against `main`'s `server.ts`. The suite's one failure, `db-cost.test.ts`, also fails on `main`.
- Not run: Linux, Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
