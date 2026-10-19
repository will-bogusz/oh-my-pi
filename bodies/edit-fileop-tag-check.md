## What

I noticed an agent could delete a file with `REM` under a tag it made up, and the edit tool just did it and warned about a `PUT <1:` the call never had, so I made bare `MV`/`REM` need the file's current tag like every other edit.

A hashline section that holds only `MV dest` or `REM` now applies only when its tag matches the file; otherwise it gets the usual rejection (`hash #X is not from this session` for an invented tag, `file changed between read and edit` for a stale one) and nothing moves or is deleted.

| `[a.txt#TAG]` section, tag does not match `a.txt` | `main` | this PR |
|---|---|---|
| `REM`, invented tag `#0000` | deletes `a.txt`, warns about `PUT <1:`/`PUT >$:` | rejected, `a.txt` kept |
| `REM`, tag of an earlier read (file changed since) | deletes `a.txt`, same warning | rejected, `a.txt` kept |
| `MV b.txt`, invented or stale tag | moves `a.txt` to `b.txt`, same warning | rejected, nothing moved |
| `PUT <1:` / `PUT >$:` (with or without `MV`), stale tag | applies with the drift warning | unchanged |
| `MV` / `REM`, current tag | applies | unchanged |

## Why

`apply_with_recovery` lets a section through under a non-matching tag when none of its edits is anchored to a line: an insert at the head or tail lands in the same place whatever the file now holds, so the tag check is skipped and `HEADTAIL_DRIFT_WARNING` is attached. A bare `MV` or `REM` has no edits at all (`stage_patch` passes `REM` an empty slice), so "no anchored edit" was vacuously true and the file op ran on a tag nothing had checked. For a delete or a move the tag is the only evidence the caller saw this file, so an empty edit list now takes the same `mismatch` rejection an anchored edit gets when recovery fails.

Decisions:
- Only the empty-edit case changes. `MV` after a `PUT <1:`/`PUT >$:` keeps the head/tail path, since the insert, not the move, is what the drift warning describes and the content it adds does not depend on the old text. In the recorded calls below, 11 of 12 head/tail-drift applies were appends under an invented tag, which this keeps working.
- No new warning: with no edits left there is nothing a recovered `MV`/`REM` applies on top of, so the section either matches or is rejected.
- Not changed: `REM` on a file that is not valid UTF-8 stages without content and never reaches this check.

## Testing

- Reproduced on `main` through `Workspace::apply_json`: all four cases (`REM`/`MV` × invented/stale tag) succeeded, deleting or moving `a.txt`, each with the `PUT <1:`/`PUT >$:` warning.
- `file_ops_reject_a_tag_that_does_not_match_the_file` covers those four cases: rejection text, no write request, `a.txt` intact, no `b.txt`. It fails on `main` (the first case deletes the file) and passes here.
- Control: `head_insert_still_applies_across_a_stale_tag` (`PUT <1:` + `MV` under a stale tag) passes on both, with the drift warning; the existing `patcher.json` fixtures "deletes a tagged file with REM" and "moves a file without content edits" keep live-tag file ops applying.
- Corpus of recorded `edit` calls since 2026-10-01 (25,077 calls): 18 sections held only `MV`/`REM`; 17 had the current tag and apply unchanged, 1 was an `MV` under an invented `#0000` on a file the agent had never read, which this PR rejects.
- Live through `ReadTool` + `EditTool` (hashline) with this branch's native addon: `REM` and `MV b.txt` under an invented tag and under the tag of a read made before the file changed are rejected with `a.txt` intact; under the current tag both apply.
- `cargo test -p pi-edit`: all pass.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
