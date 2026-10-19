## What

After I update omp, every session I left open from before the update kills the shared word-completion daemon every 30 seconds, so ghost text dies in the old sessions and the new ones keep reloading the model; an older client now just uses the newer daemon.

In the in-place upgrade repro below, an old session goes from 5 of 5 completions failing to 5 of 5 answered, and the daemon goes from 3–5 restarts in 2.5 minutes to none.

`connectDaemon` (`predict/client.ts`) still retires a daemon from an **older** omp, so a new session replaces the old daemon as before. A daemon from a **newer** omp (by `Bun.semver.order`; an unparseable version counts as not newer) is now kept and used.

Closes #15610

## Why

There is one daemon per agent directory, named by the directory alone. On `main` the client shut down any daemon reporting another version. After an in-place upgrade, an old session's client finds the new daemon, shuts it down, then starts a replacement from the executable on disk, which is the new build, so it mismatches again. Three rounds later it gives up with `text-predict daemon did not start` and retries 30 s later. Each round stops the daemon every new-version session is using, and the next request reloads the engine. Running a source checkout next to an installed omp of another version does the same on every alternation.

**Decision:** keep the daemon keyed by agent directory rather than adding the version to its name. Version-keyed daemons would run two engines over the same learned-state directory and `cursor.json`, each persisting over the other, and an old session would still spawn the new build under its old key.

**Maintenance cost:** an older client now talks to a newer daemon, so a later protocol change should keep answering the requests older clients send. A request the newer daemon rejects only costs that session its ghost text, which is where `main` already left it.

**Not covered:** sessions running a build without this change still retire newer daemons, so the first upgrade after this ships still shows the bug once.

## Testing

`test/text-predict-client.test.ts` serves a stand-in daemon on the real endpoint with a broker that has no daemons: a newer-version daemon answers the completion and receives no `shutdown`; an older one receives `shutdown`. With the `client.ts` change reverted, the newer-version test fails with `text-predict daemon did not start`.

Live, two source worktrees with `VERSION` overridden, one temporary `HOME`, `ngram`, 2 runs per arm (counts from the omp logs):

| Scenario | `main` | This PR |
|---|---|---|
| 18.12.2 and 18.12.3 clients alternate, 20 requests | 20 `shutdown requested`, 20 `engine ready` (both runs) | 0, 0 |
| Old 18.12.3 session after an in-place bump to 18.12.4, 5 requests 31 s apart | old session fails 5/5; 6 and 10 shutdowns, 3 and 5 reloads, 3 and 5 `word completion paused` warnings | old session answers 5/5; 0, 0, 0 |

```
cd packages/coding-agent && bun test test/text-predict-client.test.ts
```

`bun run check:ts` passes; `check:rs` was not run (no Rust changes).

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
