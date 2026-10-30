## What

A test run left its SQLite databases in `packages/coding-agent` and they got committed, so my clean checkout of main went dirty the next time something ran there; this deletes them and ignores SQLite files so it can't happen again.

- Removes the 7 files 71a0389398e added at the package root: `auth.db`, `models.db`, `skill-descriptions.db` and the `-shm`/`-wal` sidecars of two of them. They hold no credentials or cached data: the only rows are `auth.db`'s schema-version and change-revision markers.
- Adds `*.db`, `*.db-shm` and `*.db-wal` to the root `.gitignore`. No other file in the repo matches them.

## Why

The RPC test fixtures (`test/fixtures/*-rpc-agent.ts`) open `auth.db`, `models.db` and `skill-descriptions.db` in `process.cwd()`, which they also use as the agent dir. The tests spawn them with a temp cwd, but one run started from the package folder, and its databases went in with that commit. After that, any run with `packages/coding-agent` as cwd or agent dir rewrites the tracked files: SQLite checkpoints the WAL on close and deletes the sidecars, so `git status` shows them modified or deleted.

## Testing

On a Linux worktree, running one fixture from the package folder: `cd packages/coding-agent && bun test/fixtures/progress-events-rpc-agent.ts </dev/null` (exit 0 on both).

| | `git status --short` after the run |
|---|---|
| `main` (5d30c790b88) | `M auth.db`, `D auth.db-shm`, `D auth.db-wal`, `M skill-descriptions.db`, `D skill-descriptions.db-shm`, `D skill-descriptions.db-wal` |
| this PR | clean; the three databases it creates are ignored (`git check-ignore -v`: `.gitignore:48:*.db`) |

`git ls-files | grep -E '\.db(-shm|-wal)?$'` lists the 7 files on `main` and nothing here; `git check-ignore -v` matches every database and sidecar name (`auth`, `models`, `skill-descriptions`) to the new lines, and no other tracked path on `main` matches them. `bun check` was not run and there is no CHANGELOG line: the diff changes no source and nothing a user sees.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
