## What

I kept seeing agents find code with `grep -n` in bash and then have the edit bounced because bash output has no tag, so I made bash name the tag for the lines it actually printed.

On my sessions an `edit` whose latest view of the file was a bash numbered listing was rejected 60% of the time (1,012 of 1,700), against 6.5% after `search`; with this PR a Haiku run that greps and then edits goes from 3.35 to 3.05 calls and 38.6k to 33.7k tokens.

> **Hashline context.** `edit` anchors on line numbers under a `[path#TAG]` header that `read` and `search` print. The seen-line guard rejects lines no tagged view displayed, and an unknown tag is answered with the current one, so either way the agent retries.

When a finished `bash` call prints `N:text`, `path:N:text` (`grep -n`, `rg -n`) or `   N<TAB>text` (`cat -n`, `nl`) rows, each row whose text equals the file's current line N is recorded as displayed, as a `search` hit is, and one line names the tag:

```
$ grep -n 'const limit' retry.ts
2:	const limit = times * 2;

Edit tags for the numbered lines above: [retry.ts#25F0]
```

| The agent | `main` | This PR |
|---|---|---|
| greps with numbers, then edits a printed line | invents a tag or anchors unseen lines: rejected, retries | applies on the first call |
| edits a line bash did not print | rejected | rejected (unchanged) |
| views with `sed -n`, `head` or other unnumbered output | no tag | no tag (unchanged) |
| greps across more than four files | no tag | no tag, no file read |

No prompt text changes; the guard is unchanged.

## Why

Over 27.5k recorded `edit` calls (10-01 to 10-20), edits after a bash numbered view are 12% of calls and 43% of the rejections on 18.12.x. The guard's contract is "this line was displayed with its number": a `grep -n` row meets it, and `search` hits already count. Related: #16000 (same cause), #16253 (prompt rules for it).

- **Only numbered rows that match the file.** Replaying 1,375 such rejections, 839 apply on the first call; in 3.7% of those the agent changed an anchor after the guard's preview. Numbers derived from `sed -n A,Bp` would add 139, but 24% of those anchors were wrong (agents miscount unnumbered lines).
- **A visible tag, not only recorded rows.** Rows alone fixed the rejections but kept the "read the file for a tag" detour (insert task 41.5k tokens, 36.4k with the tag line).
- **Not a prompt rule.** #16253's two rules, measured the same way, turn rejections into reads: 35.5k on the edit task, 47.5k on the insert task (worse than `main`).

Cost: 50–75 bytes on outputs with verified rows; at most four files read; p95 3.3 ms on a 4000-line log, 0.02 ms with no numbered rows. A result past the spill threshold, a timeout or a backgrounded job records nothing. A changed row format just stops verifying.

Review first: `commit` in `planNumberedFileTags` (`tools/bash-view-tags.ts`) must never narrow an unrestricted snapshot; then `view` in `#buildCompletedResult` (`tools/bash.ts`).

## Testing

`bun test test/tools/bash-view-tags.test.ts`: 11 pass. On `main` the 8 that need a tag fail and the 3 controls (unnumbered or mismatched rows, a five-file grep, a result past the spill threshold) pass; the 5 tests for the review fixes also fail on the first commit.

Live, `omp -p` from this branch against `main`, Haiku 5.5 thinking low, a 300-line `config.ts`, 20 runs per arm, prompt asks for `grep -n` first:

| Task | Calls | Tokens (mean) | Runs with a rejected edit | Correct |
|---|---|---|---|---|
| grep, then change two values | 3.35 → 3.05 | 38.6k → 33.7k | 6 → 0 | 20/20 → 20/20 |
| grep, then insert after a multi-line property | 3.75 → 3.25 | 43.1k → 36.4k | 0 → 0 | 20/20 → 20/20 |

<details><summary>Intervals, other models, untouched paths</summary>

- 95% bootstrap intervals on tokens exclude zero: −7.9k…−2.1k and −10.0k…−3.4k.
- Sonnet 5.5, 4 runs per arm: the edit task 3.5 → 3.0 calls (2 rejected runs → 0), the insert task unchanged.
- A free-choice rename task: agents used `search`; bash printed a numbered view in 2 of 20 branch runs, so the change was barely exercised (median 47.6k vs 48.7k; one branch run renamed the wrong field with no bash call).
- The live runs used the first commit (577643b986); the second only narrows when rows are recorded (spill threshold, background jobs, inner `cd`, retained snapshots), which none of these tasks reach.
- The shared tool harness (140 cases through a real session) matches `main` apart from ports and timestamps; `bun run check:ts` and the bash, grep and edit suites (318 tests) pass.
</details>

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
