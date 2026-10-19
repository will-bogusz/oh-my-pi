## What

When an edit got rejected for a stale or unknown tag and the agent resent under the tag the rejection handed back, the seen-line guard stopped checking anything, so one of my sessions overwrote a line it had never been shown. Now that resend only counts the rows the rejection actually displayed as seen.

`edit` answers a stale or unknown tag with the file's current tag and a few rows around each anchor. If no `read` had recorded the current content, that reply recorded it with no seen set, and the guard skips a snapshot with no seen set entirely: every line passes, and so does the cut-line check from 3c49131232. Now the displayed rows (anchor ±2) become that snapshot's seen set.

| Resend under the reply's tag | `main` | This PR |
|---|---|---|
| anchors on a row the reply displayed | applies | applies |
| anchors on a row it did not display | applies | seen-line rejection that reveals the row (the usual retry) |
| content a `read` already recorded | that read's seen set | that set plus the displayed rows |
| content recorded with no or an empty seen set (a `write`) | applies | applies (unchanged) |

## Why

In my sessions since 10-01 (all Opus 5.5), 509 edits used a tag first handed back by a mismatch reply. 418 had no read-recorded seen set to fall back on, and 16 of those anchored outside the displayed rows. One was plainly wrong: `PUT 58.=58` replaced an undisplayed `Snapshot(AxSnapshot)` variant with a duplicate `Unit` line, and the next edit had to put it back. A second looks like a redo of the same kind, and one failed before writing. With this change exactly those 16 get the guard's reject-and-reveal, one extra call each; the other 402 behave as before.

Decisions:
- Displayed rows are added, never subtracted: a read's seen set gains them and a later mismatch reply adds its own. Content already unrestricted (no seen set, or the empty one a `write` records, #15666) stays unrestricted, so a file the agent wrote isn't narrowed.
- No column cap: the rejection prints each row whole and nothing truncates error text on the way to the model, so a wide displayed row counts as seen.
- `format_anchored_context` and the recorded set share one helper, `anchored_context_lines`, so the rows recorded are the rows printed.


## Testing

- `tag_from_a_mismatch_reply_covers_only_the_rows_it_displayed`: `#0000` with anchor 5 on a 30-line file, then a resend under the returned tag at line 20 is rejected with nothing written, and at line 7 it applies. `each_mismatch_reply_adds_the_rows_it_displayed` (a second reply's rows count) and `wide_row_a_mismatch_reply_prints_whole_counts_as_seen` (the reply prints the 604-char row whole; it applies, an undisplayed row doesn't). All three fail on `main`. `mismatch_reply_keeps_the_provenance_of_recorded_content` (a full read, then a mismatch, then line 20 applies) passes on both, guarding against over-tightening.
- `cargo test -p pi-edit` passes.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
