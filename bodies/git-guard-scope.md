## What

I scoped the git guard to the checkouts several sessions can share: in a worktree of its own an agent can now drop its own edits and move its branch, with whatever that discards saved first, and a repository's main checkout keeps every refusal.

Replaying two weeks of refused commands plus two cross-branch `stash pop`s, refusals drop from 510 on `main` to 66 with this PR, and both still refuse the 3 cases where the guard protected work. Tasks that hit the guard finished 8/24 times on `main` and 24/24 with this PR (Haiku and GPT-6.1 Sol).

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/2ac04a03-a5e3-4d7e-a993-39eeb3c57468">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/97a7a226-cbd0-41e9-9344-6d5b357a9d95">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/03845d29-07e1-4eb4-9e37-8cb46717c543">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/2492a0e5-1ca4-4bcb-b027-7bf9a4873382">
  <img width="780" alt="Decision flow for a git command that discards or moves work: stash other than list/show/create, reset --hard or to another commit, checkout, switch, working-tree restore. 1. Git pointed at another repository (--git-dir, GIT_DIR)? Yes: refused on main and this PR. 2. Is the checkout a linked worktree (git worktree add) or a submodule inside one? No (a main checkout or clone): refused on both, except a targeted checkout or restore mid-conflict; this PR's message says other sessions may be using the checkout and that it runs in a worktree of your own. 3. stash pop, apply, drop, branch or clear of a stash-list entry the guard cannot show was saved on the current branch? Yes: refused on both. 4. Is it a discarding form (reset --hard, --mixed or --merge, a forced or path checkout, working-tree restore)? No (stash push, branch switch, reset --soft or --keep): main refuses, this PR runs. 5. Does it recurse into submodules, with submodules present? Yes: refused on both. 6. Are there uncommitted tracked changes? No: main refuses except a targeted checkout or restore mid-conflict, this PR runs. 7. Can they be saved on refs/omp/discarded? No: refused on both, except a targeted checkout or restore mid-conflict. Yes: main refuses except a targeted checkout or restore mid-conflict; this PR saves them, prints the commit, then runs. Mid-conflict means a merge, rebase, cherry-pick or revert is underway." src="https://github.com/user-attachments/assets/97a7a226-cbd0-41e9-9344-6d5b357a9d95" />
</picture>

## Why

`bash.gitGuard` exists for checkouts several sessions share, but refuses by command name everywhere. Of 510 refusals in our sessions (10-09 to 10-23), one protected anything: an empty `$W` made `cd "$W" && git reset --keep <branch>` reset the shared main checkout instead of a worktree. Of the other 509, 451 ran in worktrees or scratch repositories. With workarounds they cost about 1,280 calls; 38 ended with the task undone and 17 did or likely did damage, such as a half-reverted tree mid-test.

Worktrees do share one stash list, and before the guard `git stash pop` twice applied another branch's entry. pop, apply, drop, branch and clear now read the entry's subject (`WIP on <branch>:` / `On <branch>:`) and refuse one not saved on the branch checked out here.

- **Shared unless it is a linked worktree.** Refusing only in main checkouts that have worktrees would leave unguarded a plain clone that several sessions open. The stricter rule costs 4 refusals in the data, all in one-agent `git init` repositories. Clones that borrow objects (`--shared`, task-isolation copies) stay guarded, because borrowing objects says nothing about who else uses the checkout.
- **Save, then run.** Before a command discards tracked changes, `git stash create` records them on one ref, `refs/omp/discarded`. stderr names the commit and `git stash apply --index <id>`. Older entries expire with the reflog (30 days by default). The guard refuses when the save fails, except for a targeted checkout or restore mid-conflict, since git cannot record unmerged entries. It also refuses when the command recurses into submodules, because the save does not cover them.

**Not covered:** git run outside the shell builtin, untracked files, and `git clean`. **Residual risk:** git pops `stash@{n}` milliseconds after the check reads it; another worktree's push in between gets popped instead. Closing that needs a lock across both.

## Testing

**Replay.** Each refused command reran through both builtins in a fixture rebuilt to its session's state. The control drops this PR's scoping and stash check.

| Where it ran | Refused cases | Protective | `main` refuses | This PR refuses | Control refuses |
|---|---|---|---|---|---|
| Main checkout with linked worktrees | 59 | 1 | 59 | 59 | 0 |
| Linked worktree | 449 | 2 (the `stash pop`s) | 447 | 3 | 0 |
| One-agent `git init` repository | 4 | 0 | 4 | 4 | 0 |

**Behaviour.** 4 tasks that hit the guard, 3 runs each, thinking low:

| | Haiku, `main` | Haiku, this PR | Sol, `main` | Sol, this PR |
|---|---|---|---|---|
| Tasks finished | 3/12 | 12/12 | 5/12 | 12/12 |
| Refused calls | 14 | 3 | 11 | 3 |
| Got around the guard (edit tool, git from Python) | 3 | 0 | 2 | 0 |
| Lost work or half-reverted trees | 0 | 0 | 0 | 0 |

Both refused the empty-path reset every time; after `main`'s message Haiku stopped (3/3), after this PR's it found the worktree and synced it (3/3).

<details><summary>Method, tests and builds</summary>

- Replay fixtures reproduce each refusal's checkout (a main checkout with linked worktrees, a linked worktree, a `git init` repository), clean or dirty, with other branches' stash entries where the session had them. Each case's commands run through the `git` builtin of a `main` build (with the conflict-exemption fix this builds on) and of this branch's build. The control build makes `is_private` return true and `foreign_stash` return `None`. A case can hold several git commands (579 across 512 cases). This PR printed a save note in 135 of the 446 cases it now runs. The rest had nothing to save or used forms that skip the save (stash push, a branch switch, `reset --soft`/`--keep`). The third worktree refusal is a `stash pop` on a detached HEAD.
- Behaviour tasks: in a worktree, revert a fix to see its test fail, then restore it; sync a worktree's branch; sync a worktree through a lookup that comes back empty, so the reset lands in the main checkout; stash, test and pop, with another branch's entry already in the list. Each run got a fresh fixture. Models: `anthropic/claude-haiku-5-5` and `openai-codex/gpt-6.1-sol`, `--thinking low`, `omp -p --no-session --mode json`. `main` there is 0b5c27ab24, before the conflict-exemption fix, which none of these tasks reaches. The sample ran on an earlier head of this branch (59d6335a4d). Since then, borrowed-object clones count as shared, `reset --merge`/`--mixed` save first, recursive discards are refused, and the note says `--index`. No task touched a clone, those reset modes or submodules, so it was not rerun.
- `cargo test -p pi-shell --lib git::` (109) and `cargo test -p pi-vcs` (92) pass on Linux. `rust-check` passes on Linux, macOS and Windows. New tests cover:
  - saving before `checkout`, `reset --hard` and `reset --merge` in a worktree, with staged-only changes coming back through `--index`;
  - the main checkout and a clone staying refused, including through `cd "$EMPTY"`;
  - submodules following their superproject, and recursive discards being refused;
  - stash entries being taken back only on the branch that saved them.

</details>

**Review first:** `is_private`, `save_then_run`, `foreign_stash`.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
