## What

I made the bash minimizer return a diff, a `jq` result or `ssh` output whole when it fits in 16 KB, because the agent asked to read that output and a summary of it often sent the agent back to the raw artifact for another call.

In a live check with Haiku 5.5, `git show HEAD` and a `jq` query each went from 2.0–2.4 tool calls (every run read `artifact://`) to 1 call, with the same 8/8 correct answers.

| Command | Up to 16 KB, `main` | Up to 16 KB, this PR | Over 16 KB |
|---|---|---|---|
| `git diff`, `git show`, `diff` | stat plus 6 changed lines per hunk, no context lines | the patch as printed | unchanged summary |
| `jq` | first 40 lines, each cut at 120 chars | the result as printed | unchanged 40-line cap |
| `ssh` | head 100 / tail 80 past 200 lines | every line (login notices still stripped) | unchanged head/tail |

## Why

Across 10,755 minimized bash results in our sessions (July–October), the agent opened the raw artifact within the next 8 calls after 45% of minimized `jq` results (202 of 447) and 44% of minimized `git diff`/`git show` patches (454 of 1,029). A patch that lost only its context lines was still reopened 30% of the time. Each reopen is a turn at about 106k tokens of context, plus the raw bytes on top of the summary.

Replaying those raw outputs through this branch's minimizer, counting a reopen wherever one followed on `main` and the output is still summarized:

| Family | Reopens, `main` → PR | Context bytes (shown + reopened) |
|---|---|---|
| `jq` | 202 → 42 | +7% |
| `git diff`/`git show`/`diff` | 470 → 213 | +7% |
| `ssh` (changed on `main`) | 50 → 25 | +3% |

**Decisions.**
- A size budget, not removing the filters: passing everything through cut reopens further (`jq` 202 → 6) but added 50% (`jq`) and 36% (diffs) more context bytes.
- 16 KB, not 32 KB: 32 KB added 19% bytes for 15–30% fewer reopens.
- Keeping every changed line but no context fixed only 28% of diff reopens, for 48% more bytes.
- `jq` keeps its TOML def, so a user pipeline still replaces it; the def gains a `keep_whole_up_to_bytes` key (16384, pinned to the Rust constant by a test). `ssh.toml` drops its `max_lines = 200` overlay, which would otherwise cut what the Rust filter now keeps whole. `yadm diff`/`show` keep the summary, since `yadm.toml` caps all yadm output at 80 lines and would cut a whole patch inside its first file.

Non-goals: test-runner and build filters keep their compaction; `bun test` summaries were reopened 13% of the time.

## Testing

- `cargo test -p pi-shell` (Linux): new tests cover each family under and over the budget, the exact 16,384-byte `ssh` boundary, a `git show` whose message alone passes the budget (still summarized), `yadm diff` keeping its summary, and `jq.toml`'s key matching the Rust constant. With the fix reverted, five of them fail (`output_within_whole_budget_is_returned_whole`, `diff_within_…`, `show_within_…`, `ssh_whole_budget_counts_the_captured_bytes`, `jq_def_keeps_results_whole_up_to_the_shared_budget`). The failing-`jq` shell test now uses output past 16 KB so it still proves the reported-error guard.
- Live: `omp -p`, Haiku 5.5 low, 8 runs per arm: a repo whose `HEAD` rewrites 14 lines of one function (3 KB `git show`) and a 60-row `jq` select (2.8 KB). The PR arm set `shellMinimizer.except: [git, jq]`, which yields the same whole output at these sizes.
- `scripts/rust-check` for Linux and Windows. Not run: macOS.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
