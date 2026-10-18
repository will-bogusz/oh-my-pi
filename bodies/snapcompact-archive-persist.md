## What

After resuming my long sessions, the next snapcompact compaction kept losing the newest archived history, because session saving cut the archive's source text at 500k characters, so I made it save that text whole, as it already does for frames.

In one long session, the archive grew to 1.34M characters while every saved copy stayed at 500,000; about 710k characters of the newest history were dropped across the chain without being counted in `truncatedChars`, and the literal `[Session persistence truncated large content]` notice was drawn into later frames.

| | `main` | this PR |
|---|---|---|
| Archive text in the saved compaction entry | cut to 500k chars, notice appended | saved whole |
| Next compaction after a resume | folds the cut text: newest history gone, `truncatedChars` unchanged, notice rendered as history | folds the full text |
| Frames, `withoutThinking` frames | blob refs | blob refs (unchanged) |

## Why

`truncateForPersistence` caps every string over 500k and only knows to externalize frame base64 under `frames`. The archive's `text`, `textHead` and `textTail` are not image data, so they fell into the generic cut. The live session kept the full text in memory, so nothing showed until the session was reopened and compacted again: `snapcompact.compact` then prepends the previous `archive.text` to the new history and re-renders from it, and the cut is the newest end of that text.

The slot under `preserveData.snapcompact` now goes through `persistSnapcompactArchive`: frames (and the `withoutThinking` view's frames) still externalize through the same path, and the text regions persist verbatim, as `anthropicCompaction` carriers already do. The text is bounded by the archive's own frame budget, so a compaction line grows by at most that, once per compaction. Rejected: storing the text as a blob, which the image-only blob helpers don't support and the loader would have to resolve before every re-render.

Non-goal: archives already saved with the notice. Their lost text is not on disk, so there is nothing to restore.

## Testing

`test/session-manager/snapcompact-archive-persistence.test.ts` compacts 131 turns (over 600k chars of archive text, default shape), appends the result through a file-backed `SessionManager`, reopens the file, and compacts once more from the reloaded `preserveData`. It asserts the new archive's source has no notice, still holds the newest archived turn, and `totalChars` did not drop.

- With the fix: passes (1 pass), along with a unit test that both views' frames still become blob refs while their text stays whole.
- Fix reverted (`main`'s `session-persistence.ts`): fails at the first assertion, the reloaded archive's source containing `[Session persistence truncated large content]`.

The focused session persistence files (archive, images, lazy frame resolution, reasoning dedup, signatures) pass: 29 of 29. Ran on Linux; no model call is involved. `bun run check` in `packages/coding-agent` passes.

`bun test packages/coding-agent/test/session-manager/snapcompact-archive-persistence.test.ts packages/coding-agent/test/session-persistence-images.test.ts packages/coding-agent/test/session-manager/snapcompact-frame-lazy-resolution.test.ts`

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
