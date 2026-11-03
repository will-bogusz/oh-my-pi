## What

The `--models` flag dropped out of the CLI reference when #16297 merged, so I put its row back where the second `--model` row ended up.

`docs/cli-reference.md`, *Model selection*: the table listed `--model <id-or-role>` twice and had no `--models <a,b,c>` row. This replaces the duplicate with `main`'s original row, byte for byte as it stood before that merge:

| Flag | Description |
| --- | --- |
| `--models <a,b,c>` | Comma-separated model patterns for `Ctrl+P` cycling. |

One line changes; the first `--model` row and the rest of the table are untouched.

## Why

A merge-resolution slip: the conflict in this table was resolved by keeping both copies of the reworded `--model` row, which overwrote the `--models` row next to it (merge `86ba2c3ab95`; its first parent still has the row). The flag itself is unchanged: `--models` is still parsed in `cli/flag-tables.ts` and scopes the session's model set.

Non-goal: the row's wording is restored as it was, matching `omp --help`. Both say `Ctrl+P` cycles the `--models` patterns, while `Ctrl+P` now cycles configured roles (`cycleRoleModel`); only RPC `cycle_model` walks the scope. Rewording the row and the help text together is a separate change.

No CHANGELOG entry: root `docs/` belongs to no package.

## Testing

- `git show 86ba2c3ab95^1:docs/cli-reference.md` line 108 and the head's line 108 are identical (`diff` empty).
- Rendered the table through GitHub's GFM endpoint (`gh api markdown`): ten flag rows, `--model` once, `--models <a,b,c>` between `--plan` and `--provider`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
