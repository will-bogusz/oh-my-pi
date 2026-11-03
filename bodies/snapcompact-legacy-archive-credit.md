## What

and then regarding the snapcompact I attempted where it rejected, was that appropriate? or could we have continued leveraging snapcompact to optimize the context in use?

A session whose last snapcompact archive was saved before omp 16.1.0 lost that archive's imaged history at its next snapcompact without saying so. In 16 offline replays the new summary counted those frames as dropped in none on `main` and in all 15 that commit here; the 16th refuses.

> **Snapcompact context.** An archive is history rendered into image frames between plain-text edges. Since 16.1.0 it also keeps `text`, its whole source, which the next compaction re-renders. A 16.0.x archive has frames and a text tail but no `text`: the next archive can carry its edges, never its imaged middle.

| | `main` | this PR |
|---|---|---|
| "Would not reduce context" check, new archive replacing a 16.0.x one | counts the old frames as replaced (the text tail passes for source text) | counts them only when the old archive has `text`, on `/compact`, pre-prompt and threshold compaction alike |
| The new archive's summary | `truncatedChars` unchanged: nothing says the middle is gone | `About 61647 characters of older middle history dropped to fit archive budget.` |

Non-goal: keeping that middle. Nothing reads it back as text (an LLM summary gets only the edges too); carrying old frames forward needs a new archive layout.

## Why

#17490 counts the previous archive as replaced unless it has frames and no source text. It tested that with `snapcompact.archiveSourceText`, which falls back to `textHead + textTail`, so a 16.0.x archive passed as re-renderable and a smaller candidate carrying only its edges passed too. Threshold compaction compares against its stored trigger estimate, which counts the whole old summary; it now takes such a summary back out.

`compact()` re-rendered such an archive from its edges with `truncatedChars` unchanged. It now adds the frames' `chars`, as `viewWithoutThinking` does for frames it leaves out; the dead-end frame rescue runs through it too.

Decision: this keeps #17490's all-or-nothing rule rather than crediting the old summary's text but not its images, which committed every replay, the refused one included.

Reading order: `SessionMaintenance#replacesStandingSummary` and its callers, then `truncatedChars` in `snapcompact.compact()`.

## Testing

No session on our machines holds a pre-16.1.0 archive (about 3,600 snapcompact entries scanned), so the replay copies two real snapcompacted sessions (5 and 4 frames) into an isolated agent dir, removes `text` from the last archive (frames and tail as 16.0.x wrote it, or frames and both edges), keeps 4 entries after it or all, and runs `/compact snapcompact` or a threshold-crossing turn offline (mock auth, no model call):

| 16 replays | `main` | this PR |
|---|---|---|
| Committed | 16 | 15; one refused: `snapcompact would not reduce context. Run /compact soft instead.` |
| Old frames' characters reported as dropped | 0 | all 15 (61,647 and 43,463) |

With `text` kept, both commit and keep the middle, on `main` and here.

- `test/agent-session-snapcompact-no-reduction.test.ts` (coding-agent): 'does not count frames it cannot re-render…' now gives the archive `textHead`/`textTail`, and a new case runs it through a threshold-crossing turn. On `main`'s source both commit; with only the threshold fix reverted the new one does. Two other tests there fail on `main` too (`claude-haiku-5-5`'s window is 1M).
- `test/snapcompact.test.ts`: the legacy frame-only case checks `truncatedChars`, 0 on `main`, 12 here; 121 of 121 pass. `bun check` flags formatting only in two untouched files, as on `main`.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
