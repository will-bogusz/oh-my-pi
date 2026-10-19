## What

When I replace the last item of a JSON list and leave a trailing comma on it, `edit` tells me the body indentation doesn't say where a boundary row goes, so I go re-read the file instead of just dropping the comma.

With this PR, in a next-call test with the same file and failed edit, the first reply went from 0/45 correct (all 45 re-read first) to 45/45 correct.

| `PUT 4.=4:` with body `+    "z",` on `{"a": ["x", "y"]}` | Error |
|---|---|
| `main` | … a selected boundary row is required for the file to parse, but the body indentation does not establish whether it belongs before or after that row. Re-read the region and re-issue with a range that excludes every unchanged boundary row. |
| This PR | … the body's last non-blank row ends with a comma that does not parse in place (e.g. a trailing comma before a closing `]` or `}`); without that comma this replacement parses. Drop the comma, or include the rows that should follow it in the same body. |

Only the error text changes: every edit `main` accepts or rejects is still accepted or rejected, with the same written bytes.

## Why

A one-row replacement that breaks the file on its own, at the same indentation as the row it replaces, is rejected as a placement question (a closer swapped for a statement). A JSON element that gains a trailing comma lands there too, but no placement is in question: the replacement is just invalid where it sits. Over 18 days of my sessions, 4 of 41 such rejections were exactly this, all JSON; two of the agents filed it as a tool bug before finding the comma.

`group_variants` now checks, only on that rejection path, whether the group's replacement parses once the comma ending its last non-blank row is removed (nothing else is removed). If it does, `repair_boundaries` returns `trailing_comma_replacement_message`; otherwise `main`'s message. When two repairs elsewhere in the batch parse differently, the placement message stays.

Decisions:
- Reject rather than apply with the syntax-error warning: the edit is still wrong, so rejecting keeps the file valid.
- The message says the replacement parses, not the file: another edit in the same batch may still break it.

## Testing

- `cargo test -p pi-edit`: passes. `names_the_trailing_comma_that_keeps_a_one_row_replacement_from_parsing` (`tests/hashline_apply.rs`) fails on `main`; the negative control `keeps_the_placement_rejection_when_dropping_the_comma_does_not_parse` (a comma standing in for a closer, and a comma followed by a non-breaking space) passes on both.
- Replay: the 41 recorded rejections, with the file text recovered by tag for 33, through the crate's `Session` on `main` and on this branch. 31 reproduce on `main`; the 2 trailing-comma cases get the new message, the other 29 keep `main`'s message byte for byte, and the 2 that apply on current `main` write the same bytes.
- Next-call test (old vs new message, same scenario; 3 scenarios: two recorded JSON files and one small config): Claude Haiku 5.5 n=10 per arm per scenario, `main` 30/30 re-read first, this PR 30/30 dropped the comma in one call; after the re-read, `main` reached the right file in 25/30, the other 5 wrote invalid JSON. GPT-6.1 Sol n=5 per arm per scenario: 15/15 re-read vs 15/15 fixed.
- Not run: a live `omp` session. The replay goes through the same `Session::apply` the tool calls, and nothing in TypeScript reads this message.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
