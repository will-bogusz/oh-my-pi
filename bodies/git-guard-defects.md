## What

I closed the gaps that let commands the git guard exists to stop run anyway while it was on, and stopped it refusing `git stash create`, which changes nothing.

With `bash.gitGuard` on, each command below ran in a fresh fixture under `main`'s guard and under this branch's:

| Command | State | `main` | This PR |
|---|---|---|---|
| `git restore tracked.txt` | a conflicted rebase that has since finished | runs, discards the edit | refused |
| `git checkout -B t2 HEAD~1` | same | let through | refused |
| `git checkout -d`, `git checkout --det` | merge resolved, not committed | runs, detaches HEAD, drops the merge | refused |
| `git checkout remoteonly` (only `origin/remoteonly` exists) | same | runs, creates and switches to a branch, drops the merge | refused |
| `git checkout -B main2 HEAD~1` | same | let through | refused |
| `git checkout --theirs tracked.txt` | same | runs | runs |
| `git reset --ha` | uncommitted edit | runs, discards the edit | refused, as `--hard` is |
| `git stash create` | uncommitted edit | refused | runs |

**Not changed:** which checkouts the guard covers, and every refusal not listed above.

## Why

The guard refuses `checkout`, `switch` and `restore` unless a merge, rebase, cherry-pick or revert is underway, so an agent can still pick conflict sides. Three gaps widened that exemption:

- **A finished rebase counted as one forever.** `GitRepo::operation_in_progress` counted `REBASE_HEAD`, which git leaves behind once a rebase that stopped on a conflict completes. In one of our sessions, `git checkout -q -B <branch> HEAD~1` went through seconds after the guard refused `git reset --hard HEAD~1` in the same worktree. 2 of the 105 checkouts of our clone carry such a file today. A real rebase always has `rebase-merge/` or `rebase-apply/`, which still count.
- **Mid-conflict, the exemption covered branch switches too.** These are not side picks: they move HEAD and drop `MERGE_HEAD`. Branch options (`-b`, `-B`, `-d`, `--detach`, `--orphan`, `-t`), `switch`, and a lone operand that names a revision now get the branch-move refusal during a conflict as well. A lone operand counts as a path only when it names no revision and no remote branch git would check out.
- **Long options matched by full name only.** Git takes any unique abbreviation. The guard now resolves them against each subcommand's option list, through the same `long_option` helper the `git worktree add` layer already uses.

`git stash create` only writes a commit object and prints its id. Agents use it to save a tree before a test run, so a refusal there cost a call for nothing.

## Testing

- `cargo test -p pi-shell --lib git::` on Linux: 104 passed. New: `a_finished_rebase_is_not_a_conflict`, a mid-merge fixture with a remote-only branch that asserts HEAD, the checked-out branch and `MERGE_HEAD` survive every refused switch, and parser rows for abbreviations, `-d` and `--orphan`.
- **Negative control:** the table is that run, `main`'s guard against this branch's, through the shell builtin. With `REBASE_HEAD` back in the list and the `create` arm removed, `a_finished_rebase_is_not_a_conflict`, `stash_is_refused_however_it_is_spelled` and `reads_arguments_as_git_does` fail.
- **Replay:** the guard refused 510 commands in our sessions between 10-09 and 10-23. Rerun in fixtures rebuilt to each session's state, this branch refuses the same 510 except one `git stash create`.
- `rust-check` (clippy, rustfmt) passes on Linux, macOS and Windows.

**Review first:** `names_path` in `guard.rs`. It decides whether `checkout <operand>` is a side pick or a switch. When a file and a revision share a name, it now refuses without `--`, where `main` let git choose.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
