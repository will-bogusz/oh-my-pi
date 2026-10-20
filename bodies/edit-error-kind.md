## What

I kept counting edit rejections by grepping their text, and the wording moved under me this week, so now the engine says which check refused the edit and `/session` adds them up.

A failed edit's `details` goes from `{}` (all 1,503 failed edits in my sessions since 10-14) to `{ diff: "", errorKind }`, where `errorKind` names the check that refused it (`unseen_lines`, `stale_tag`, `parse`, …; all 18 in `docs/tools/edit.md`). The message the model reads is unchanged.

`/session` on a resumed Haiku session with one rejected edit:

```diff
 Tool Calls: 7
 Tool Results: 7
+Edit Rejections: 1 (unseen lines 1)
 Total: 16
```

Text classifiers against the field, on the same recorded failures:

| Failed edits | First-line regex classifier | `scripts/session-stats` `classify_edit_result` | `errorKind` |
|---|---|---|---|
| 17 scripted rejections, 13 kinds, through a real `AgentSession` | 9/17 right | 1/17 right, 6 more in a class spanning several kinds | 17/17 |
| 5 rejections in 16 live Haiku 5.5 sessions | 5/5 | 0/5 (`fail:other`) | 5/5 |
| 1,503 failures in my sessions since 10-14 (no field) | 12 unmatched | 1,185 `fail:other` (79%), 1,002 of them seen-line rejections | — |

**Cost:** 43–52 bytes on each failed edit's entry, none elsewhere. Edit wall time over 5 alternating harness runs: rejected edits 9.3 vs 9.4 ms mean; successful edits within run-to-run spread (per-run means 4.6–12.1 ms on `main`, 3.9–20.7 ms here, loaded host).

## Why

Edit fails on about 1 call in 6 in my sessions, more than any other busy tool, and the only record of why is prose. Counting causes means matching text that also carries file content: `classify_edit_result` puts seen-line rejections under `fail:other`, and 32 whose revealed rows say "cancelled" or "parseArgs" under `aborted` or `fail:parse`. Every rewording needs the classifiers updated with it, as the 10-19 untagged-header replies did. The engine already builds a distinct message per check, so it names the check there.

- **Source of the kind:** a `Rejection` reason on a new `EditError::Rejected` for the hashline checks, and `EditError::kind()` for every variant; every `Display` is unchanged.
- **Multi-file calls:** `apply_patch` and sloppy re-wrapped a file's failure as `Apply`/`Match`; `EditError::InFile` keeps the inner error, so a missing file is `file_not_found` alone or beside another file.
- **`diff: ""`** keeps `EditToolDetails.diff` required for extension and hook consumers.
- **Not here:** kinds for warnings on successful edits (4% of them), thrown errors from other tools, `omp stats` columns, `analyze.py` reading the field (its sync stores no `details`).

**Maintenance:** a new `EditError` site gets its variant's kind (`apply`, `no_match`); a new `Rejection` also goes in the anonymizer's `errorKind` list, or exports replace it with a placeholder.

<details><summary>Reading order</summary>

`crates/pi-edit/src/error.rs` (`Rejection`, `kind`, `InFile`) → hashline sites (`mismatch.rs`, `patcher.rs`, `apply.rs`, `clipboard.rs`) → `pi-natives/src/edit.rs` → `edit/index.ts` → `session-stats.ts` and `/session` → anonymizer → the renderer condition in `tui/src/tools/edit.ts`, which lets the streamed preview still locate a failed edit as on `main`.

</details>

## Testing

- `cargo test -p pi-edit`: 393 pass, incl. each hashline check's kind, past-EOF `PUT`/`CUT`/paste, and missing-file and invalid-UTF-8 kinds alone and in multi-file `apply_patch`/sloppy calls. `rust-check` clean on Linux and macOS.
- `bun run check:ts` passes; `bun test` of the five touched test files and `rpc.test.ts`: 82 pass. With `src` reverted the four new tests fail.
- 17 scripted rejections, `main` vs here: tool text identical apart from the sandbox path.
- 16 live Haiku 5.5 (low) sessions: each rejection carried its kind; resumed in the TUI, `/session` shows the line above, `main` none.
- Not run: Windows.

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
