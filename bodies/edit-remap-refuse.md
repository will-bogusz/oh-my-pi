## What

I kept seeing edits under an old tag land a few lines off when the agent took its line numbers from grep or sed of the current file, so I made the remap back off when the body was clearly written for the current line or the shifted edit breaks the syntax.

In 57 recorded remaps, 23 overwrote a different line than the agent meant; this refuses 18 of those and none of the 28 correct remaps.

> **Recovery context.** An edit under a stale `[path#tag]` is shifted by the offset between that tag's snapshot and the current file, then applied with "Recovered by remapping stale line anchors…". Right when the numbers came from the tagged `read`; wrong when they came from an untagged view of the current file (`grep -n`, `sed -n`, `:raw`, compiler output), which are already current.

Same edit, `PUT 3.=3:` `+start the engine twice` under the old tag of `start the engine / check the oil / drive home`, with two header lines added since:

| | Result |
|---|---|
| `main` | writes it over line 5 (`drive home`), warns "Verify the diff matches your intent" |
| this PR | `Edit rejected for doc.txt: file changed between read and edit.` with the current tag and `*3:start the engine` |

For a shifted remap, `try_recover` (`hashline/recovery.rs`) now falls through to the existing mismatch reject when:

- **the body fits the authored line** (`aimed_at_authored_lines`): a replacement keeps at least half of the current lines at its authored numbers, and 0.3 more than of the remap target (best `fuzzy::similarity` per line; lines under 8 chars count for nothing; a bounded comparison budget);
- **the remap breaks the parse**: the result carries `edit_broke_parse_warning`.

Recovery now cuts into a fork of the clipboard, so a refused `CUT` no longer fills the register later sections preview.

## Why

The warning comes after the line is overwritten, and 10 of the 23 wrong remaps left a file that still parsed.

| Rule | wrong remaps refused | correct remaps refused |
|---|---|---|
| parse break only | 13 / 23 | 0 / 28 |
| body fits authored line only | 15 / 23 | 0 / 28 |
| either (this PR) | 18 / 23 | 0 / 28 |

Not caught: 3 inserts and 1 `CUT` that kept the parse, and one replacement whose remap landed on a closing brace. Any margin from 0.1 to 0.4 gives the same counts (correct remaps peak at +0.02).

**Cost:** a tagged-read rewrite whose new text closely resembles the line `offset` away (a placeholder replaced by a statement like its neighbour) is refused too; the agent retries under the printed tag. None of the 28 correct remaps hit this.

Rejected: refusing every shifted remap (drops all 28 correct ones).

## Testing

- `cargo test -p pi-edit` passes. With `main`'s `recovery.rs`, `recovery_refuses_a_remap_of_a_body_written_for_the_current_line`, `recovery_refuses_a_shifted_remap_that_breaks_the_parse` and `recovery_parse_refusal_leaves_the_clipboard_untouched` fail; the remap controls (tagged line, overlapping range, blank fill, short body, loose rewrite, accepted cut) pass on both. `recovery_skips_the_body_check_past_its_comparison_budget` fails with the budget removed.
- Replay: the 53 recorded replacement ops, rebuilt with their real current and target lines in a shifted file, through `try_recover`: `main` remaps all 53, this PR refuses exactly the 22 the analysis predicts.
- Shifted 100 to 1,200-line replacements take as long as on `main` (137 vs 134 ms at 1,200).

<details><summary>How the 57 cases were labelled</summary>

Every edit result carrying the remap warning from 2026-10-02 to 2026-10-19 in one user's sessions (all Claude Opus 5.5). For each: the tag's snapshot lines, the current lines at both numbers, where the line number came from (tagged read, edit response, `grep -n`, `sed -n`, `:raw`), and what followed (a restore of the overwritten line, `git checkout` of the file, the body re-applied elsewhere). Correct: 28. Wrong, numbers from the current file: 23. Numbers wrong in both views: 5 (2 refused by the parse check). Wrong file: 1. Excluding the session that produced most cases: wrong 7 / 8 refused, correct 0 / 19.

</details>
