## What

When two of my agents cleaned up the same folder at once, the bash tool's `rm -rf` printed thousands of `No such file or directory` lines and left the folder behind, so under `-f` an entry that is already gone now counts as removed, as in GNU rm.

Two bash-tool `rm -rf T` calls started together on a 3,000-directory tree (5 rounds, Linux):

| | `main` | this PR |
|---|---|---|
| Calls returning an error | 10 of 10 | 0 of 10 |
| `No such file or directory` lines | 6,790 | 0 |
| Rounds that left part of `T` behind | 5 of 5 | 0 of 5 |

Permission errors and every other failure still print and still fail the call, with or without `-f`. As in GNU rm, a later `-i`, `-I` or `--interactive=always|once` turns the leniency off again (`rm -fi` reports a file deleted while its prompt waited; `rm -if` does not).

## Why

Each walk lists a directory, then deletes its entries. When the other walk got there first, the delete failed with `ENOENT`; the builtin printed it, counted it as a failure, and a failed child makes the walk keep its parent directory, so both runs could finish with directories neither removed. GNU rm treats `ENOENT` and `ENOTDIR` as "already gone" under `-f` (`nonexistent_file_errno` in coreutils `remove.c`); only the missing operand at the top level did so here.

One check, `is_missing_under_force` in `rm.rs`, now covers each place a delete, open or stat can find the entry gone: the descriptor walk (`handle_unlink`, the opening `lstat`/`open`), the provider walk used for URLs and non-Unix hosts, the retry that removes a directory it cannot list, the Windows long-path and read-only-attribute paths, and the single-file and empty-directory helpers. Without `-f` nothing changes.

Non-goal: making the two walks cooperate; each just stops treating the other's progress as an error.

## Testing

- `concurrent_forced_removals_both_succeed` (`rm.rs`) runs two `rm -rf tree` at once on a 3,000-directory tree and expects both to exit 0 with no stderr and the tree gone. With the check disabled it fails 20 of 20 runs (exit 1, `cannot remove 'tree/d0335': No such file or directory`); with it, it passes 20 of 20.
- `interactive_after_force_still_reports_a_vanished_file` answers the `-i` prompt after deleting the file: `-fi` exits 1 with `cannot remove 'file'`, `-if` exits 0. Without the interactive condition it fails (`-fi` exits 0).
- `forced_rm_of_a_directory_gone_while_refused_succeeds` (`pi-shell/tests/vfs.rs`) uses a provider directory that is deleted while its listing is refused: `rm -rf` exits 0 silently, `rm -r` still reports `Permission denied`. With main's recovery branch it fails (`Permission denied`, exit 1).
- The same race in-process, 20 rounds: `main` 40 of 40 runs exit 1 with 54,567 stderr lines; this PR 0 of 40, 0 lines.
- The table is the bash tool itself (`BashTool.execute`, two concurrent calls), natives built from `main` and from this branch.
- `cargo test -p pi-builtins --lib rm::` (13) and `cargo test -p pi-shell --test vfs` (14) pass.
- Not run: Windows. The provider walk is shared with URL paths and tested there; the long-path and read-only-attribute branches are Windows-only and were not compiled or run here.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
