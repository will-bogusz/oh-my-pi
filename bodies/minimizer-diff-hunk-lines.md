## What

I kept seeing minimized diffs list a file that doesn't exist, and it turned out a removed SQL comment or an added `++` line was being read as a file header, so the diff parser now follows each hunk's line counts.

The bash tool's diff summary (`git diff`, `git show`, `diff -u`) now keeps every changed line under its own file; a changed line starting with `-- ` or `++ ` used to open a made-up file that took the rest of its hunk. A removed `-- old comment` prints as `--- old comment` and an added `++ new heading` as `+++ new heading`, the same text as file headers.

One real 47 KB `git diff` (`q.sql` loses `-- old comment` and `select 1;`, gains 1,200 lines, `++ new heading` and `select 2;`; `doc.md` loses a `---` rule; `r.sql` changes one line), as the model receives it:

```text
main:
doc.md | 1 -
q.sql | 1201 ++++++++++++++++++++++++
new heading | 1 +
r.sql | 2 +-
4 files changed, 1202 insertions(+), 3 deletions(-)

this PR:
doc.md | 2 --
q.sql | 1204 ++++++++++++++++++++++++
r.sql | 2 +-
3 files changed, 1203 insertions(+), 5 deletions(-)
```

Below the stat, `main` also leaves `--- old comment` and the removed rule (`----`) out of the hunk samples; this PR shows both.

## Why

`parse_unified_diff` tested every line for `--- ` and `+++ ` first. Now it reads the counts in each `@@ -a,b +c,d @@` header (an omitted count is 1), and while the hunk still owes lines it classifies each one by its first character: `-` removed, `+` added, space or empty line context, `\` the no-newline marker. Headers are recognised only after the counts run out, which is where git and `diff -u` print them.

- Any other line (`diff --git`, `@@`, `index …`) ends the hunk early, so output whose counts overstate a hunk parses as it did on `main`.
- Combined diffs (`@@@`, merge commits in `git show`) keep `main`'s handling: their headers carry several old ranges, and nothing here counts them.

In my own sessions, 64 of 2,634 minimized diffs (2.4%) had such a line inside a hunk: Markdown `---` rules, `++` items in docs, SQL and Lua comments.

Non-goal: which lines the summary samples, and how many per hunk, is unchanged.

## Testing

- `cargo test -p pi-shell --lib minimizer` on Linux: 777 passed.
- New tests in `filters/git.rs`: `diff_hunk_lines_starting_with_header_prefixes_stay_in_their_hunk` (2 files; `--- old comment`, `+++ new heading`, `-select 1;`, `+select 2;` under `q.sql`; no `new heading` file), `diff_counts_a_removed_markdown_rule`, and `hunk_counts_default_to_one_and_skip_combined_headers`. The diff inputs are over 16 KiB so the summary path runs.
- Negative control: with the hunk counts forced to zero (`main`'s parsing), both diff tests fail.
- The outputs above are a scratch repo's real `git diff` run through the git filter on `main` and on this branch.
- `rust-check` (clippy, rustfmt) on Linux and Windows.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
