## What

Agents kept getting told their Markdown edits broke the file, which can't happen in Markdown, so I made the edit tool stop reporting a parse regression for `.md` files.

Appending a valid table row like `| b |||` (empty cells written as `||`; GitHub renders it fine) to a `.md` file returned two warnings on `main`, and none with this PR:

> This edit introduced a syntax error near line 5: the file parsed before the patch and no longer does. It was applied exactly as written, so a line number or range endpoint is likely wrong — re-read the touched region and re-issue a correcting edit.
>
> Warning: notes.md no longer parses after this edit. The change was applied; re-read the edited region and fix the syntax, or revert if unintended.

Both tell the agent a correct edit is wrong. The second also writes an edit-blackbox entry and, with `edit.autoRepair.enabled`, has the smol model "repair" the region.

## Why

Any text is a valid CommonMark document, so an edit cannot break a Markdown file. tree-sitter-md (0.5.3; 0.5.4 too) still emits `ERROR` nodes for some valid GFM, most often a table row with an empty `||` cell. `edit_can_break_syntax` (`crates/pi-edit/src/session.rs`) is false for Markdown paths and gates both places that report a regression: the hashline warning in `apply_edits` and the session's `parseRegressed` flag (second warning, blackbox, auto-repair; every edit mode).

Decisions:
- The parse check itself (`parse_code_status`, `parses_cleanly`) is unchanged. The hashline repair probes use it as evidence that a moved insertion or boundary repair yields a clean tree; with Markdown always passing, an insertion jumped past a list into a broken table "verified by the syntax probe". Summaries need it too: after that `ERROR` the grammar folds the next `## heading` into the table.
- Markdown only: in other grammars an `ERROR` is usually a real error.

Non-goals: false positives in languages that can be invalid (tree-sitter-bash on `"${VAR:+… \"$X\"}"`, tree-sitter-swift 0.7.3 on compact `;` statements) need grammar updates, not a skip.

Maintenance: one extension check for `SupportLang::Markdown`.

Related: #17875 asks for an option to reject edits that break the parse, which would refuse correct Markdown edits.

## Testing

- Live, `omp -p` with Haiku 4.5 on goliath, asked to append `| b |||` to a clean table in `notes.md`: on `main` (88a69582c75) the edit result carried both warnings above; on this branch the same edit wrote the same bytes with no warning.
- `markdown_edits_never_warn_of_a_syntax_error` (`crates/pi-edit/tests/hashline_apply.rs`, hashline warning) and `does not warn when tree-sitter misreads valid Markdown` (`packages/coding-agent/test/edit-blackbox.test.ts`, session flag, `replace` mode): with the `crates/pi-edit/src` hunks reverted, each fails on its warning; with them, both pass.
- `cargo test -p pi-edit` and `-p pi-ast` pass; `bun test` of `edit-blackbox`, `auto-repair` and natives `parse-status` pass (26).

---

- [x] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
