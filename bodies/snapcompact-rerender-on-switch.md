## What

When I switch to a model that reads a different frame shape best, the snapcompact archive now gets redrawn in that shape from its kept source text, instead of replaying the frames drawn for the model that compacted.

Live, a session compacted on Claude Opus 5.5 and continued on Devin's Gemini 4 Carbon sent Carbon Claude's 1932 px frames on `main`; with this PR it sends 2048 px frames in Gemini's grid.

<picture>
  <source media="(min-width: 1244px) and (prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/630572b9-6db5-4774-a8b4-b4c7d61c596f">
  <source media="(min-width: 1244px) and (prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/85078b86-4cf4-49f4-9f1b-c944b4b997f3">
  <source media="(prefers-color-scheme: dark)" width="440" srcset="https://github.com/user-attachments/assets/29f89742-529c-48a3-b5d1-4fc02f1e889e">
  <source media="(prefers-color-scheme: light)" width="440" srcset="https://github.com/user-attachments/assets/ec36be47-4bb7-4ede-93b1-3397fb189f87">
  <img width="780" alt="Decision flow for the frames a model reads from a snapcompact archive. A model without image input gets the archive's text, and frames already in the reader's shape, or an archive without its whole source text, are sent as they are, on main and with this PR. When the reader's best shape differs, main sends the same frames in another model's shape; this PR re-renders them from the source text in the reader's shape, sized to its budgets." src="https://github.com/user-attachments/assets/85078b86-4cf4-49f4-9f1b-c944b4b997f3" />
</picture>

> **Snapcompact context.** Compaction draws old history into PNG frames in a shape (font cell, grid, frame size) that `resolveShape` picks for the compacting model, keeping the source text beside them. Later requests replay the frames.

Reading order: `archiveInShape` (snapcompact.ts) tells whether frames are in a shape; `SessionMaintenance#viewInShape` (session-maintenance.ts) re-renders through the existing `#rerenderSnapcompactArchive`; `#archiveEntry` takes over `#mayReplayThinking`'s "no archive on this branch" memo, as every snapcompact summary now takes that lookup.

## Why

Each model family reads a different frame shape best. In a read-back eval of matched archives (outside this repo), Gemini 4 Carbon read Claude's 1932 px frames at 0.73 character accuracy and Gemini-shaped frames at 0.93–0.99. `main` redraws an archive for a later reader only for Claude's no-reasoning view.

- **Where:** the reader-view pass that already swaps in the text view and that no-reasoning view (model switch, each model call, side requests).
- **Cache:** in memory, per compaction entry, by shape, frame cap and reasoning policy. The entry stays the compacting model's record; a resume re-renders once (~210 ms for 1.1M characters) to the same bytes. Not the blob store: it is content-addressed, and `omp gc --apply` collects unreferenced blobs.
- **Frame count:** the reader's own limits, as compaction uses: `MAX_FRAMES_DEFAULT`, byte budget, image-count budget, window share less the text edges.
- **No whole source text** (none, or cut short by persistence before #16282): the frames stay, since a re-render would drop history they hold.
- **Removes nothing:** `capArchiveFrameBytes` still serves same-shape readers on hosts with a smaller byte budget.

Non-goals: shape choice in KDL; persisting re-rendered views. Related: #19591 adds per-model overrides to `resolveShape`; this applies whatever it resolves.

## Testing

- `bun test packages/coding-agent/test/agent-session-snapcompact-reader.test.ts -t 'another frame shape'`: an archive compacted for Opus 5.5, read by Gemini 3.5 Flash, sends only 2048 px frames; back on Opus, the original frames. Fails with the fix reverted.
- Live through the real `devin/gemini-4-carbon` path (request captured, failed before sending), after compacting on `anthropic/claude-opus-5-5` (14 frames, 1932 px): `main` sent 5 frames 1932 px wide, this PR 5 at 2048 px.
- Reader tests 11/11; compaction suites pass but two `agent-session-snapcompact-no-reduction` cases, failing on `main` too (they expect Haiku 5.5's old window).

---

- [x] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
